"""
Upload history dialog — shows recently queued/completed uploads for this session.
Refreshes automatically when a new upload completes via the uploadFinished signal.
"""

import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import List

from qgis.PyQt.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QTableWidget, QTableWidgetItem,
    QHeaderView, QAbstractItemView, QDialogButtonBox,
)
from qgis.PyQt.QtCore import Qt
from qgis.PyQt.QtGui import QColor

from ..upload_task import UploadJob, UploadSignals


@dataclass
class HistoryEntry:
    timestamp:  str
    filename:   str
    project_id: int
    folder_id:  int
    success:    bool
    message:    str


class HistoryDialog(QDialog):
    """Non-modal dialog that stays open and auto-updates."""

    MAX_ENTRIES = 200

    def __init__(self, signals: UploadSignals, parent=None):
        super().__init__(parent)
        self._signals = signals
        self._entries: List[HistoryEntry] = []
        self.setWindowTitle('RakshaGIS Sync — Upload History')
        self.setMinimumWidth(700)
        self.setMinimumHeight(420)
        self.setWindowFlags(self.windowFlags() | Qt.WindowStaysOnTopHint)
        self._build_ui()
        signals.uploadFinished.connect(self._on_upload_finished)
        signals.queueChanged.connect(self._on_queue_changed)

    # ── UI ───────────────────────────────────────────────────────────────────

    def _build_ui(self):
        root = QVBoxLayout(self)

        # Status strip
        status_row = QHBoxLayout()
        self.queue_lbl = QLabel('Queue: 0 pending')
        self.success_lbl = QLabel('Uploaded: 0')
        self.fail_lbl = QLabel('Failed: 0')
        status_row.addWidget(self.queue_lbl)
        status_row.addStretch()
        status_row.addWidget(self.success_lbl)
        status_row.addWidget(QLabel('|'))
        status_row.addWidget(self.fail_lbl)
        root.addLayout(status_row)

        # Table
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(['Time', 'File', 'Project', 'Status', 'Message'])
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.Stretch)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.setColumnWidth(0, 80)
        self.table.setColumnWidth(2, 70)
        self.table.setColumnWidth(3, 75)
        root.addWidget(self.table)

        # Buttons
        btn_row = QHBoxLayout()
        clear_btn = QPushButton('Clear History')
        clear_btn.clicked.connect(self._clear)
        btn_row.addWidget(clear_btn)
        btn_row.addStretch()
        close_btn = QPushButton('Close')
        close_btn.clicked.connect(self.hide)
        btn_row.addWidget(close_btn)
        root.addLayout(btn_row)

    # ── Slots ────────────────────────────────────────────────────────────────

    def _on_upload_finished(self, job: UploadJob, success: bool, message: str):
        entry = HistoryEntry(
            timestamp=datetime.now().strftime('%H:%M:%S'),
            filename=os.path.basename(job.file_path),
            project_id=job.project_id,
            folder_id=job.resolved_folder_id or 0,
            success=success,
            message=message,
        )
        self._entries.insert(0, entry)
        if len(self._entries) > self.MAX_ENTRIES:
            self._entries = self._entries[:self.MAX_ENTRIES]
        self._refresh_table()
        self._refresh_counters()

    def _on_queue_changed(self, count: int):
        self.queue_lbl.setText(f'Queue: {count} pending')

    def _refresh_table(self):
        self.table.setRowCount(len(self._entries))
        for row, e in enumerate(self._entries):
            self.table.setItem(row, 0, self._cell(e.timestamp))
            self.table.setItem(row, 1, self._cell(e.filename))
            self.table.setItem(row, 2, self._cell(str(e.project_id)))
            status_item = self._cell('✓ Done' if e.success else '✗ Failed')
            status_item.setForeground(QColor('#52c41a') if e.success else QColor('#ff4d4f'))
            self.table.setItem(row, 3, status_item)
            self.table.setItem(row, 4, self._cell(e.message))

    def _refresh_counters(self):
        ok = sum(1 for e in self._entries if e.success)
        fail = sum(1 for e in self._entries if not e.success)
        self.success_lbl.setText(f'Uploaded: {ok}')
        self.fail_lbl.setText(f'Failed: {fail}')
        self.fail_lbl.setStyleSheet('color: red' if fail > 0 else '')

    def _clear(self):
        self._entries.clear()
        self.table.setRowCount(0)
        self._refresh_counters()

    @staticmethod
    def _cell(text: str) -> QTableWidgetItem:
        item = QTableWidgetItem(text)
        item.setTextAlignment(Qt.AlignVCenter | Qt.AlignLeft)
        return item
