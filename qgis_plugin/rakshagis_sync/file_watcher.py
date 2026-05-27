"""
FileWatcher — two modes of automatic upload trigger:

Mode A: QFileSystemWatcher
  Watches one or more output directories on disk.
  Any new supported file triggers an upload job.
  Configured via Settings → "Watch Folders" list.

Mode B: QGIS Processing hook
  Connects to QgsApplication.processingRegistry().algorithmFinished
  and picks up any output layers/files written to disk by the algorithm.
  Maps the algorithm provider/ID to a RakshaGIS module folder name.
"""

import os
import time
from typing import Dict, List, Optional, Set

from qgis.core import QgsApplication
from qgis.PyQt.QtCore import QFileSystemWatcher, QObject, QTimer, pyqtSignal

from .api_client import RakshaGISClient
from .upload_task import UploadManager


class FolderWatcher(QObject):
    """
    Wraps QFileSystemWatcher for a set of watched directories.
    Debounces rapid file-system events (e.g. during multi-file writes)
    with a 1-second settle timer before enqueuing.
    """

    newFileDetected = pyqtSignal(str)   # emits absolute file path

    SETTLE_MS = 1200    # wait this long after last event before processing

    def __init__(self, manager: UploadManager, project_id: int,
                 module_name: Optional[str] = None,
                 skip_duplicates: bool = True,
                 parent: Optional[QObject] = None):
        super().__init__(parent)
        self._manager = manager
        self._project_id = project_id
        self._module_name = module_name
        self._skip_duplicates = skip_duplicates

        self._watcher = QFileSystemWatcher(self)
        self._watcher.directoryChanged.connect(self._on_directory_changed)
        self._watcher.fileChanged.connect(self._on_file_changed)

        self._known_files: Set[str] = set()
        self._pending: Set[str] = set()

        self._settle_timer = QTimer(self)
        self._settle_timer.setSingleShot(True)
        self._settle_timer.setInterval(self.SETTLE_MS)
        self._settle_timer.timeout.connect(self._flush_pending)

    # ── Public interface ─────────────────────────────────────────────────────

    @property
    def watched_dirs(self) -> List[str]:
        return self._watcher.directories()

    def add_directory(self, path: str) -> bool:
        if not os.path.isdir(path):
            return False
        # Snapshot existing files so we don't re-upload them
        for fname in os.listdir(path):
            self._known_files.add(os.path.join(path, fname))
        self._watcher.addPath(path)
        return True

    def remove_directory(self, path: str) -> None:
        self._watcher.removePath(path)

    def set_project(self, project_id: int, module_name: Optional[str] = None) -> None:
        self._project_id = project_id
        self._module_name = module_name

    # ── Slots ────────────────────────────────────────────────────────────────

    def _on_directory_changed(self, path: str) -> None:
        """Triggered when files are added/removed in a watched directory."""
        if not os.path.isdir(path):
            return
        for fname in os.listdir(path):
            fpath = os.path.join(path, fname)
            if fpath not in self._known_files and os.path.isfile(fpath):
                self._known_files.add(fpath)
                if RakshaGISClient.is_supported(fpath):
                    self._pending.add(fpath)
        self._settle_timer.start()

    def _on_file_changed(self, path: str) -> None:
        """Triggered when a watched file is modified (e.g. in-place overwrite)."""
        if os.path.isfile(path) and RakshaGISClient.is_supported(path):
            self._pending.add(path)
            self._settle_timer.start()

    def _flush_pending(self) -> None:
        """Enqueue all pending files after settle timer fires."""
        for fpath in list(self._pending):
            if os.path.isfile(fpath):
                self._manager.enqueue(
                    file_path=fpath,
                    project_id=self._project_id,
                    module_name=self._module_name,
                    skip_duplicates=self._skip_duplicates,
                )
                self.newFileDetected.emit(fpath)
        self._pending.clear()

    def stop(self) -> None:
        self._settle_timer.stop()
        paths = self._watcher.directories() + self._watcher.files()
        if paths:
            self._watcher.removePaths(paths)


# ── Processing algorithm hook ─────────────────────────────────────────────────

class ProcessingHook(QObject):
    """
    Connects to QgsApplication.processingRegistry().algorithmFinished.
    When an algorithm completes, collects output file paths and
    enqueues them for upload.

    The hook is only active when:
      - enabled = True
      - a default project is configured
    """

    uploadTriggered = pyqtSignal(str, str)   # (file_path, algorithm_id)

    def __init__(self, manager: UploadManager, parent: Optional[QObject] = None):
        super().__init__(parent)
        self._manager = manager
        self._enabled = False
        self._project_id: Optional[int] = None
        self._connected = False

    # ── Public interface ─────────────────────────────────────────────────────

    def enable(self, project_id: int) -> None:
        self._project_id = project_id
        self._enabled = True
        if not self._connected:
            try:
                QgsApplication.processingRegistry().algorithmFinished.connect(
                    self._on_algorithm_finished
                )
                self._connected = True
            except AttributeError:
                pass   # older QGIS without this signal

    def disable(self) -> None:
        self._enabled = False
        if self._connected:
            try:
                QgsApplication.processingRegistry().algorithmFinished.disconnect(
                    self._on_algorithm_finished
                )
            except Exception:
                pass
            self._connected = False

    # ── Slot ─────────────────────────────────────────────────────────────────

    def _on_algorithm_finished(self, alg, context, feedback):
        """
        Called after any QGIS Processing algorithm finishes.
        Collect all output file paths and enqueue them.
        """
        if not self._enabled or self._project_id is None:
            return

        alg_id = alg.id() if alg else ''

        # Collect output file paths from context
        output_paths = self._collect_outputs(alg, context)

        for fpath in output_paths:
            if RakshaGISClient.is_supported(fpath):
                self._manager.enqueue(
                    file_path=fpath,
                    project_id=self._project_id,
                    algorithm_id=alg_id,
                    skip_duplicates=True,
                )
                self.uploadTriggered.emit(fpath, alg_id)

    def _collect_outputs(self, alg, context) -> List[str]:
        """Extract file system paths from algorithm outputs."""
        paths = []

        if context is None:
            return paths

        # Method 1: layersToLoadOnCompletion (new-style algorithms)
        try:
            for layer_name, details in context.layersToLoadOnCompletion().items():
                path = getattr(details, 'path', '') or ''
                if path and os.path.isfile(path):
                    paths.append(path)
        except Exception:
            pass

        # Method 2: outputDefinitions → check OUTPUT* parameters
        try:
            if alg:
                for out in alg.outputDefinitions():
                    out_name = out.name()
                    val = context.outputs().get(out_name, '')
                    if isinstance(val, str) and os.path.isfile(val):
                        paths.append(val)
        except Exception:
            pass

        return list(set(paths))   # deduplicate


# ── Multi-directory watcher manager ──────────────────────────────────────────

class WatcherManager(QObject):
    """
    Top-level manager for all watchers.  Stored on the plugin instance.
    Maps directory paths to FolderWatcher instances.
    """

    def __init__(self, upload_manager: UploadManager, parent: Optional[QObject] = None):
        super().__init__(parent)
        self._upload_manager = upload_manager
        self._watchers: Dict[str, FolderWatcher] = {}
        self.processing_hook = ProcessingHook(upload_manager, self)

    def watch(self, directory: str, project_id: int,
              module_name: Optional[str] = None) -> bool:
        if directory in self._watchers:
            return True  # already watching
        watcher = FolderWatcher(
            self._upload_manager, project_id, module_name, parent=self
        )
        ok = watcher.add_directory(directory)
        if ok:
            self._watchers[directory] = watcher
        return ok

    def unwatch(self, directory: str) -> None:
        w = self._watchers.pop(directory, None)
        if w:
            w.stop()

    def unwatch_all(self) -> None:
        for w in self._watchers.values():
            w.stop()
        self._watchers.clear()

    def watched_directories(self) -> List[str]:
        return list(self._watchers.keys())

    def enable_processing_hook(self, project_id: int) -> None:
        self.processing_hook.enable(project_id)

    def disable_processing_hook(self) -> None:
        self.processing_hook.disable()

    def stop_all(self) -> None:
        self.unwatch_all()
        self.disable_processing_hook()
