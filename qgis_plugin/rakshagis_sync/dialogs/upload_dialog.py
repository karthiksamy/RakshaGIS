"""
Manual upload dialog — lets the user pick files and choose target project/folder.
Supports drag-and-drop and multi-file selection.
"""

import os
from typing import List, Optional

from qgis.PyQt.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout,
    QLabel, QPushButton, QListWidget, QListWidgetItem,
    QComboBox, QCheckBox, QDialogButtonBox, QFileDialog,
    QGroupBox, QLineEdit, QAbstractItemView, QMessageBox,
    QProgressBar,
)
from qgis.PyQt.QtCore import Qt, QThread, pyqtSignal
from qgis.PyQt.QtGui import QDropEvent, QDragEnterEvent

from ..api_client import RakshaGISClient
from ..upload_task import UploadManager


class DropFileList(QListWidget):
    """QListWidget that accepts drag-and-drop files."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DropOnly)
        self.setSelectionMode(QAbstractItemView.ExtendedSelection)

    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent):
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if os.path.isfile(path) and RakshaGISClient.is_supported(path):
                self._add_if_new(path)
        event.acceptProposedAction()

    def _add_if_new(self, path: str):
        existing = [self.item(i).data(Qt.UserRole) for i in range(self.count())]
        if path not in existing:
            item = QListWidgetItem(os.path.basename(path))
            item.setData(Qt.UserRole, path)
            item.setToolTip(path)
            self.addItem(item)


class UploadDialog(QDialog):

    def __init__(self, manager: UploadManager, client: RakshaGISClient,
                 initial_files: Optional[List[str]] = None, parent=None):
        super().__init__(parent)
        self._manager = manager
        self._client = client
        self._projects = []
        self._folders = []
        self.setWindowTitle('Upload to RakshaGIS')
        self.setMinimumWidth(560)
        self.setMinimumHeight(460)
        self._build_ui()
        self._load_projects()
        if initial_files:
            for f in initial_files:
                self.file_list._add_if_new(f)

    # ── UI ───────────────────────────────────────────────────────────────────

    def _build_ui(self):
        root = QVBoxLayout(self)

        # File list
        file_box = QGroupBox('Files to Upload  (drag & drop supported)')
        file_vbox = QVBoxLayout(file_box)

        self.file_list = DropFileList()
        self.file_list.setFixedHeight(130)
        file_vbox.addWidget(self.file_list)

        btn_row = QHBoxLayout()
        add_btn = QPushButton('Add Files…')
        add_btn.clicked.connect(self._add_files)
        rem_btn = QPushButton('Remove Selected')
        rem_btn.clicked.connect(self._remove_selected)
        btn_row.addWidget(add_btn)
        btn_row.addWidget(rem_btn)
        btn_row.addStretch()
        file_vbox.addLayout(btn_row)
        root.addWidget(file_box)

        # Target
        target_box = QGroupBox('Upload Target')
        target_form = QFormLayout(target_box)

        self.project_combo = QComboBox()
        self.project_combo.currentIndexChanged.connect(self._on_project_changed)
        target_form.addRow('Project:', self.project_combo)

        self.module_edit = QLineEdit()
        self.module_edit.setPlaceholderText('e.g. Change Detection  (auto-creates folder if needed)')
        target_form.addRow('Module / Folder:', self.module_edit)

        self.folder_combo = QComboBox()
        self.folder_combo.addItem('— Auto (create from module name) —', None)
        target_form.addRow('Specific folder (optional):', self.folder_combo)

        root.addWidget(target_box)

        # Options
        opt_box = QGroupBox('Options')
        opt_vbox = QVBoxLayout(opt_box)
        self.skip_dup_chk = QCheckBox('Skip files already uploaded (duplicate check)')
        self.skip_dup_chk.setChecked(True)
        opt_vbox.addWidget(self.skip_dup_chk)
        root.addWidget(opt_box)

        # Progress
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        self.status_lbl = QLabel('')
        root.addWidget(self.progress_bar)
        root.addWidget(self.status_lbl)

        # Buttons
        self.btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        self.btns.button(QDialogButtonBox.Ok).setText('Upload')
        self.btns.accepted.connect(self._start_upload)
        self.btns.rejected.connect(self.reject)
        root.addWidget(self.btns)

    # ── Slots ────────────────────────────────────────────────────────────────

    def _add_files(self):
        exts = '*.tif *.tiff *.zip *.geojson *.json *.gpkg *.kml *.csv *.pdf *.xlsx *.png *.jpg'
        paths, _ = QFileDialog.getOpenFileNames(
            self, 'Select GIS / Report Files', '', f'Supported files ({exts});;All files (*.*)'
        )
        for p in paths:
            self.file_list._add_if_new(p)

    def _remove_selected(self):
        for item in self.file_list.selectedItems():
            self.file_list.takeItem(self.file_list.row(item))

    def _load_projects(self):
        try:
            self._client.ensure_authenticated()
            self._projects = self._client.list_projects()
        except Exception:
            return

        self.project_combo.clear()
        self.project_combo.addItem('— Select project —', None)
        for p in self._projects:
            self.project_combo.addItem(f"{p.get('project_number','?')} — {p['name']}", p['id'])

        from ..settings import PluginSettings
        saved_id = PluginSettings.default_project_id()
        if saved_id:
            for i in range(self.project_combo.count()):
                if self.project_combo.itemData(i) == saved_id:
                    self.project_combo.setCurrentIndex(i)
                    break

    def _on_project_changed(self, idx: int):
        project_id = self.project_combo.currentData()
        self.folder_combo.clear()
        self.folder_combo.addItem('— Auto (create from module name) —', None)
        if not project_id:
            return
        try:
            folders = self._client.list_folders(project_id)
            self._folders = folders
            for f in folders:
                indent = '  ' * self._folder_depth(f, folders)
                label = f"{indent}{f['name']} [{f.get('folder_type_display', f.get('folder_type',''))}]"
                self.folder_combo.addItem(label, f['id'])
        except Exception:
            pass

    def _folder_depth(self, folder: dict, all_folders: list, depth: int = 0) -> int:
        if folder.get('parent') is None or depth > 5:
            return depth
        parent = next((f for f in all_folders if f['id'] == folder['parent']), None)
        return self._folder_depth(parent, all_folders, depth + 1) if parent else depth

    def _start_upload(self):
        if self.file_list.count() == 0:
            QMessageBox.warning(self, 'No Files', 'Add at least one file to upload.')
            return
        project_id = self.project_combo.currentData()
        if not project_id:
            QMessageBox.warning(self, 'No Project', 'Select a target project.')
            return

        folder_id = self.folder_combo.currentData()
        module_name = self.module_edit.text().strip() or None
        skip_dup = self.skip_dup_chk.isChecked()

        file_paths = [self.file_list.item(i).data(Qt.UserRole) for i in range(self.file_list.count())]

        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(len(file_paths))
        self.progress_bar.setValue(0)
        self.btns.button(QDialogButtonBox.Ok).setEnabled(False)

        for i, fpath in enumerate(file_paths):
            self._manager.enqueue(
                file_path=fpath,
                project_id=project_id,
                folder_id=folder_id,
                module_name=module_name,
                skip_duplicates=skip_dup,
            )
            self.progress_bar.setValue(i + 1)
            self.status_lbl.setText(f'Queued {i + 1} / {len(file_paths)}: {os.path.basename(fpath)}')

        self.status_lbl.setText(f'✓ {len(file_paths)} file(s) queued for background upload.')
        self.btns.button(QDialogButtonBox.Ok).setEnabled(True)
        self.btns.button(QDialogButtonBox.Ok).setText('Close')
        self.btns.accepted.disconnect()
        self.btns.accepted.connect(self.accept)
