"""
Background upload system for RakshaGIS Sync.

UploadJob      — dataclass describing a single file to upload.
UploadQueue    — thread-safe FIFO queue.  Add jobs from any thread.
UploadWorker   — QgsTask subclass that drains the queue in the background.
               - 3 retries with exponential back-off (2 s, 4 s, 8 s).
               - Emits uploadFinished(job, success, message) Qt signal on completion.
"""

import os
import time
from dataclasses import dataclass, field
from queue import Empty, Queue
from typing import Any, Callable, Dict, Optional

from qgis.core import QgsTask, QgsApplication
from qgis.PyQt.QtCore import QObject, pyqtSignal

from .api_client import RakshaGISClient, APIError
from .folder_resolver import FolderResolver


# ── Upload job ────────────────────────────────────────────────────────────────

@dataclass
class UploadJob:
    file_path:        str
    project_id:       int
    folder_id:        Optional[int]  = None   # None → resolver picks/creates
    module_name:      Optional[str]  = None
    algorithm_id:     Optional[str]  = None
    layer_name:       Optional[str]  = None
    skip_duplicates:  bool           = True
    # Filled in by worker on completion
    result:           Optional[Dict] = field(default=None, repr=False)
    error:            Optional[str]  = field(default=None, repr=False)
    resolved_folder_id: Optional[int] = field(default=None, repr=False)


# ── Signals carrier ──────────────────────────────────────────────────────────

class UploadSignals(QObject):
    # (job, success, message)
    uploadFinished = pyqtSignal(object, bool, str)
    # (queued_count)
    queueChanged   = pyqtSignal(int)


# ── Upload queue ─────────────────────────────────────────────────────────────

class UploadQueue:
    """Thread-safe queue wrapper. Shared between plugin code and worker task."""

    def __init__(self):
        self._q: Queue[UploadJob] = Queue()
        self.signals = UploadSignals()

    def add(self, job: UploadJob) -> None:
        self._q.put(job)
        self.signals.queueChanged.emit(self._q.qsize())

    def add_file(self, file_path: str, project_id: int,
                 folder_id: Optional[int] = None,
                 module_name: Optional[str] = None,
                 algorithm_id: Optional[str] = None,
                 layer_name: Optional[str] = None,
                 skip_duplicates: bool = True) -> UploadJob:
        job = UploadJob(
            file_path=file_path,
            project_id=project_id,
            folder_id=folder_id,
            module_name=module_name,
            algorithm_id=algorithm_id,
            layer_name=layer_name,
            skip_duplicates=skip_duplicates,
        )
        self.add(job)
        return job

    @property
    def size(self) -> int:
        return self._q.qsize()

    def _get_nowait(self) -> Optional[UploadJob]:
        try:
            return self._q.get_nowait()
        except Empty:
            return None


# ── Worker task ──────────────────────────────────────────────────────────────

MAX_RETRIES = 3
RETRY_DELAYS = (2, 4, 8)   # seconds between retries


class UploadWorker(QgsTask):
    """
    Persistent background QgsTask that drains the UploadQueue.
    Start once; it runs until cancelled or the plugin is unloaded.
    """

    IDLE_SLEEP = 1.5   # seconds to sleep when queue is empty

    def __init__(self, queue: UploadQueue, client: RakshaGISClient):
        super().__init__('RakshaGIS Upload Worker', QgsTask.CanCancel)
        self._queue = queue
        self._client = client
        self._resolver = FolderResolver(client)

    # ── QgsTask interface ────────────────────────────────────────────────────

    def run(self) -> bool:
        """Runs in the background thread. Returns True when finished cleanly."""
        try:
            self._client.ensure_authenticated()
        except Exception as exc:
            self.setProgress(0)
            return False

        while not self.isCanceled():
            job = self._queue._get_nowait()
            if job is None:
                time.sleep(self.IDLE_SLEEP)
                continue
            self._process_job(job)

        return True

    def finished(self, result: bool) -> None:
        pass   # nothing to do on clean exit

    def cancel(self) -> None:
        super().cancel()

    # ── Job processing ───────────────────────────────────────────────────────

    def _process_job(self, job: UploadJob) -> None:
        signals = self._queue.signals

        # Validate file still exists
        if not os.path.isfile(job.file_path):
            job.error = f'File not found: {job.file_path}'
            signals.uploadFinished.emit(job, False, job.error)
            return

        # Resolve target folder
        try:
            if job.folder_id is not None:
                target = self._resolver.resolve(
                    job.project_id, job.file_path,
                    target_folder_id=job.folder_id
                )
            else:
                target = self._resolver.resolve(
                    job.project_id, job.file_path,
                    module_name=job.module_name,
                    algorithm_id=job.algorithm_id,
                )
            job.resolved_folder_id = target['id']
        except Exception as exc:
            job.error = f'Folder resolution failed: {exc}'
            signals.uploadFinished.emit(job, False, job.error)
            return

        # Duplicate check
        if job.skip_duplicates and self._resolver.is_duplicate(job.resolved_folder_id, job.file_path):
            msg = f'Skipped (already uploaded): {os.path.basename(job.file_path)}'
            job.error = msg
            signals.uploadFinished.emit(job, True, msg)  # not an error, just skipped
            return

        # Upload with retries
        last_error = ''
        for attempt in range(MAX_RETRIES):
            try:
                def _progress(pct, msg):
                    overall = int(pct * 0.9)
                    self.setProgress(overall)

                result = self._client.upload_file(
                    job.resolved_folder_id,
                    job.file_path,
                    layer_name=job.layer_name,
                    progress_callback=_progress,
                    project_id=job.project_id,
                    algorithm_id=job.algorithm_id or '',
                    module_name=job.module_name or '',
                )
                job.result = result
                self.setProgress(100)
                signals.uploadFinished.emit(
                    job, True,
                    f'Uploaded: {os.path.basename(job.file_path)}'
                )
                # Invalidate folder cache so next is_duplicate check is fresh
                self._resolver.clear_cache(job.project_id)
                return

            except APIError as exc:
                last_error = f'API error {exc.status}: {exc.detail}'
                if exc.status in (400, 403, 404):
                    break   # don't retry client errors
            except Exception as exc:
                last_error = str(exc)

            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAYS[attempt])

        job.error = last_error
        signals.uploadFinished.emit(job, False, f'Upload failed: {last_error}')


# ── Manager: single instance per plugin session ───────────────────────────────

class UploadManager:
    """
    Singleton-style manager. Creates and owns the queue + worker task.
    Call start() after login; stop() on plugin unload.
    """

    def __init__(self, client: RakshaGISClient):
        self._client = client
        self.queue = UploadQueue()
        self._worker: Optional[UploadWorker] = None

    def start(self) -> None:
        if self._worker and not self._worker.isCanceled():
            return  # already running
        self._worker = UploadWorker(self.queue, self._client)
        QgsApplication.taskManager().addTask(self._worker)

    def stop(self) -> None:
        if self._worker:
            self._worker.cancel()
            self._worker = None

    def enqueue(self, file_path: str, project_id: int,
                folder_id: Optional[int] = None,
                module_name: Optional[str] = None,
                algorithm_id: Optional[str] = None,
                layer_name: Optional[str] = None,
                skip_duplicates: bool = True) -> UploadJob:
        return self.queue.add_file(
            file_path=file_path,
            project_id=project_id,
            folder_id=folder_id,
            module_name=module_name,
            algorithm_id=algorithm_id,
            layer_name=layer_name,
            skip_duplicates=skip_duplicates,
        )

    @property
    def is_running(self) -> bool:
        return self._worker is not None and not self._worker.isCanceled()

    @property
    def signals(self) -> UploadSignals:
        return self.queue.signals
