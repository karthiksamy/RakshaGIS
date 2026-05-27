"""
Settings dialog — configure server URL, credentials, default project,
watched directories, and processing hook.
"""

import os
from typing import Dict, Optional

from qgis.PyQt.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout,
    QLabel, QLineEdit, QPushButton, QCheckBox,
    QGroupBox, QListWidget, QListWidgetItem,
    QFileDialog, QComboBox, QDialogButtonBox,
    QMessageBox, QSizePolicy, QTabWidget, QWidget,
    QTableWidget, QTableWidgetItem, QHeaderView, QAbstractItemView,
)
from qgis.PyQt.QtCore import Qt

from ..settings import PluginSettings


class SettingsDialog(QDialog):

    def __init__(self, client, parent=None):
        super().__init__(parent)
        self._client = client
        self._projects = []
        self.setWindowTitle('RakshaGIS Sync — Settings')
        self.setMinimumWidth(520)
        self._build_ui()
        self._load_settings()

    # ── UI construction ──────────────────────────────────────────────────────

    def _build_ui(self):
        root = QVBoxLayout(self)

        tabs = QTabWidget()
        tabs.addTab(self._build_connection_tab(), 'Connection')
        tabs.addTab(self._build_sync_tab(), 'Sync Options')
        tabs.addTab(self._build_mapping_tab(), 'Algorithm Mapping')
        root.addWidget(tabs)

        # ── Buttons ──
        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.accepted.connect(self._save_and_close)
        btns.rejected.connect(self.reject)
        root.addWidget(btns)

    def _build_connection_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)

        conn_box = QGroupBox('Server Connection')
        conn_form = QFormLayout(conn_box)

        self.url_edit = QLineEdit()
        self.url_edit.setPlaceholderText('http://192.168.1.100 or https://rakshagis.dgde.gov.in')
        conn_form.addRow('Server URL:', self.url_edit)

        self.user_edit = QLineEdit()
        self.user_edit.setPlaceholderText('Service account username (no 2FA)')
        conn_form.addRow('Username:', self.user_edit)

        self.pass_edit = QLineEdit()
        self.pass_edit.setEchoMode(QLineEdit.Password)
        self.pass_edit.setPlaceholderText('Password')
        conn_form.addRow('Password:', self.pass_edit)

        test_btn = QPushButton('Test Connection')
        test_btn.clicked.connect(self._test_connection)
        self.test_lbl = QLabel('')
        h = QHBoxLayout()
        h.addWidget(test_btn)
        h.addWidget(self.test_lbl)
        h.addStretch()
        conn_form.addRow('', h)
        layout.addWidget(conn_box)
        layout.addStretch()
        return w

    def _build_sync_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)

        # ── Upload options group ──
        opt_box = QGroupBox('Upload Options')
        opt_form = QFormLayout(opt_box)

        self.project_combo = QComboBox()
        self.project_combo.setMinimumWidth(300)
        refresh_btn = QPushButton('↺')
        refresh_btn.setFixedWidth(28)
        refresh_btn.setToolTip('Reload project list from server')
        refresh_btn.clicked.connect(self._load_projects)
        ph = QHBoxLayout()
        ph.addWidget(self.project_combo)
        ph.addWidget(refresh_btn)
        opt_form.addRow('Default Project:', ph)

        self.skip_dup_chk = QCheckBox('Skip files already uploaded (duplicate check)')
        opt_form.addRow('', self.skip_dup_chk)

        self.auto_proc_chk = QCheckBox('Auto-upload when a Processing algorithm finishes')
        opt_form.addRow('', self.auto_proc_chk)

        layout.addWidget(opt_box)

        # ── Watched directories group ──
        watch_box = QGroupBox('Watched Directories (background sync)')
        watch_vbox = QVBoxLayout(watch_box)

        self.dir_list = QListWidget()
        self.dir_list.setFixedHeight(110)
        watch_vbox.addWidget(self.dir_list)

        dir_btn_row = QHBoxLayout()
        add_dir_btn = QPushButton('Add Folder…')
        add_dir_btn.clicked.connect(self._add_watch_dir)
        rem_dir_btn = QPushButton('Remove Selected')
        rem_dir_btn.clicked.connect(self._remove_watch_dir)
        dir_btn_row.addWidget(add_dir_btn)
        dir_btn_row.addWidget(rem_dir_btn)
        dir_btn_row.addStretch()
        watch_vbox.addLayout(dir_btn_row)

        self.watch_module_edit = QLineEdit()
        self.watch_module_edit.setPlaceholderText(
            'e.g. "Change Detection" — leave blank to auto-detect from filename')
        watch_form = QFormLayout()
        watch_form.addRow('Module / Folder name:', self.watch_module_edit)
        watch_vbox.addLayout(watch_form)

        layout.addWidget(watch_box)
        layout.addStretch()
        return w

    def _build_mapping_tab(self) -> QWidget:
        """
        Algorithm ID → Module Name mapping table.
        Each row: algorithm_id (text input) | module_name (text input)
        The plugin checks this table before falling back to built-in defaults.

        Examples:
          qgis:changedetection  →  Change Detection
          myplugin:landuse      →  Land Use Analysis
        """
        w = QWidget()
        layout = QVBoxLayout(w)

        info = QLabel(
            'Map QGIS algorithm IDs to module/folder names on the server.\n'
            'Exact match is checked first, then prefix/substring match.\n'
            'Leave the Module Name blank to remove an entry on save.'
        )
        info.setWordWrap(True)
        layout.addWidget(info)

        self.map_table = QTableWidget(0, 2)
        self.map_table.setHorizontalHeaderLabels(['Algorithm ID (or prefix)', 'Module Name on Server'])
        self.map_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.map_table.verticalHeader().setVisible(False)
        self.map_table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.map_table.setEditTriggers(QAbstractItemView.AllEditTriggers)
        layout.addWidget(self.map_table)

        btn_row = QHBoxLayout()
        add_row_btn = QPushButton('Add Row')
        add_row_btn.clicked.connect(self._add_mapping_row)
        del_row_btn = QPushButton('Delete Selected')
        del_row_btn.clicked.connect(self._del_mapping_row)
        btn_row.addWidget(add_row_btn)
        btn_row.addWidget(del_row_btn)
        btn_row.addStretch()
        layout.addLayout(btn_row)

        example_lbl = QLabel(
            '<b>Built-in defaults (always active as fallback):</b><br>'
            'change → Change Detection | classification → Land Use Classification<br>'
            'landuse / land_use → Land Use Analysis | gdal → GDAL Processing'
        )
        example_lbl.setWordWrap(True)
        example_lbl.setTextFormat(Qt.RichText)
        layout.addWidget(example_lbl)
        return w

    # ── Slot implementations ─────────────────────────────────────────────────

    def _load_settings(self):
        self.url_edit.setText(PluginSettings.server_url())
        self.user_edit.setText(PluginSettings.username())
        self.pass_edit.setText(PluginSettings.password())
        self.skip_dup_chk.setChecked(PluginSettings.skip_duplicates())
        self.auto_proc_chk.setChecked(PluginSettings.auto_upload_on_processing())
        self.watch_module_edit.setText(PluginSettings.watch_module_name())

        for d in PluginSettings.watch_dirs():
            self.dir_list.addItem(QListWidgetItem(d))

        # Load algorithm→module mapping rows
        for alg_id, mod_name in PluginSettings.algorithm_module_map().items():
            self._add_mapping_row(alg_id, mod_name)

        # Try to load projects with existing credentials
        self._load_projects(silent=True)

    def _test_connection(self):
        self._apply_to_client()
        ok = self._client.ping()
        if ok:
            self.test_lbl.setText('✓ Connected')
            self.test_lbl.setStyleSheet('color: green')
            self._load_projects()
        else:
            self.test_lbl.setText('✗ Failed — check URL and credentials')
            self.test_lbl.setStyleSheet('color: red')

    def _apply_to_client(self):
        self._client.base_url = self.url_edit.text().strip().rstrip('/')
        self._client.username = self.user_edit.text().strip()
        self._client.password = self.pass_edit.text()
        self._client._access = None   # force re-login

    def _load_projects(self, silent: bool = False):
        try:
            self._apply_to_client()
            self._client.login()
            self._projects = self._client.list_projects()
        except Exception as exc:
            if not silent:
                QMessageBox.warning(self, 'Connection Error', str(exc))
            return

        saved_id = PluginSettings.default_project_id()
        self.project_combo.clear()
        self.project_combo.addItem('— Select a project —', None)
        for p in self._projects:
            self.project_combo.addItem(f"{p.get('project_number','?')} — {p['name']}", p['id'])
            if saved_id and p['id'] == saved_id:
                self.project_combo.setCurrentIndex(self.project_combo.count() - 1)

    def _add_watch_dir(self):
        path = QFileDialog.getExistingDirectory(self, 'Select Output Directory')
        if path and not self._dir_already_listed(path):
            self.dir_list.addItem(QListWidgetItem(path))

    def _dir_already_listed(self, path: str) -> bool:
        for i in range(self.dir_list.count()):
            if self.dir_list.item(i).text() == path:
                return True
        return False

    def _remove_watch_dir(self):
        row = self.dir_list.currentRow()
        if row >= 0:
            self.dir_list.takeItem(row)

    def _add_mapping_row(self, alg_id: str = '', mod_name: str = ''):
        row = self.map_table.rowCount()
        self.map_table.insertRow(row)
        self.map_table.setItem(row, 0, QTableWidgetItem(alg_id))
        self.map_table.setItem(row, 1, QTableWidgetItem(mod_name))

    def _del_mapping_row(self):
        rows = sorted({idx.row() for idx in self.map_table.selectedIndexes()}, reverse=True)
        for r in rows:
            self.map_table.removeRow(r)

    def _read_mapping_table(self) -> Dict[str, str]:
        result: Dict[str, str] = {}
        for r in range(self.map_table.rowCount()):
            alg = (self.map_table.item(r, 0) or QTableWidgetItem('')).text().strip()
            mod = (self.map_table.item(r, 1) or QTableWidgetItem('')).text().strip()
            if alg and mod:
                result[alg] = mod
        return result

    def _save_and_close(self):
        PluginSettings.set_server_url(self.url_edit.text().strip())
        PluginSettings.set_username(self.user_edit.text().strip())
        PluginSettings.set_password(self.pass_edit.text())
        PluginSettings.set_skip_duplicates(self.skip_dup_chk.isChecked())
        PluginSettings.set_auto_upload_on_processing(self.auto_proc_chk.isChecked())
        PluginSettings.set_watch_module_name(self.watch_module_edit.text().strip())

        pid = self.project_combo.currentData()
        PluginSettings.set_default_project_id(pid)

        dirs = [self.dir_list.item(i).text() for i in range(self.dir_list.count())]
        PluginSettings.set_watch_dirs(dirs)

        PluginSettings.set_algorithm_module_map(self._read_mapping_table())

        self.accept()
