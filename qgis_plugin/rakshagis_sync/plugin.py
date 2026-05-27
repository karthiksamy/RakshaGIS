"""
RakshaGIS Sync — Main Plugin Class
Wires together: API client, upload manager, file watcher, dialogs, toolbar.

Toolbar actions:
  [⬆ Upload]  [📋 History]  [👁 Watch]  [⚙ Settings]

Layer panel context menu (via iface.layerTreeView()):
  "Upload to RakshaGIS…"
"""

import os
from typing import Optional

from qgis.core import QgsApplication, QgsMapLayer
from qgis.PyQt.QtGui import QIcon
from qgis.PyQt.QtWidgets import QAction, QToolBar, QMessageBox

from .api_client import RakshaGISClient
from .dialogs.history_dialog import HistoryDialog
from .dialogs.settings_dialog import SettingsDialog
from .dialogs.upload_dialog import UploadDialog
from .file_watcher import WatcherManager
from .processing_provider import RakshaGISProvider
from .settings import PluginSettings
from .upload_task import UploadManager


class RakshaGISSyncPlugin:

    def __init__(self, iface):
        self.iface = iface
        self._client: Optional[RakshaGISClient] = None
        self._manager: Optional[UploadManager] = None
        self._watcher: Optional[WatcherManager] = None
        self._provider: Optional[RakshaGISProvider] = None
        self._history_dialog: Optional[HistoryDialog] = None
        self._toolbar: Optional[QToolBar] = None
        self._actions = []
        self._layer_menu_action: Optional[QAction] = None

    # ── QGIS lifecycle ────────────────────────────────────────────────────────

    def initGui(self):
        self._init_client()
        self._init_manager()
        self._init_watcher()
        self._register_provider()
        self._build_toolbar()
        self._install_layer_context_menu()
        self._apply_saved_settings()

    def unload(self):
        if self._watcher:
            self._watcher.stop_all()
        if self._manager:
            self._manager.stop()
        if self._provider:
            QgsApplication.processingRegistry().removeProvider(self._provider)
            self._provider = None
        if self._toolbar:
            self.iface.mainWindow().removeToolBar(self._toolbar)
            self._toolbar = None
        self._uninstall_layer_context_menu()

    # ── Initialisation helpers ────────────────────────────────────────────────

    def _init_client(self):
        self._client = RakshaGISClient(
            base_url=PluginSettings.server_url(),
            username=PluginSettings.username(),
            password=PluginSettings.password(),
        )

    def _init_manager(self):
        self._manager = UploadManager(self._client)
        # Attempt background login; start worker only if successful
        try:
            self._client.login()
            self._manager.start()
        except Exception:
            pass  # user must open Settings and test connection first

    def _init_watcher(self):
        self._watcher = WatcherManager(self._manager)
        # Connect processing hook upload signal to status bar
        self._watcher.processing_hook.uploadTriggered.connect(self._on_processing_upload)
        # Connect upload results to status bar
        self._manager.signals.uploadFinished.connect(self._on_upload_finished)

    def _register_provider(self):
        self._provider = RakshaGISProvider()
        QgsApplication.processingRegistry().addProvider(self._provider)

    def _apply_saved_settings(self):
        """Restore watchers and processing hook from saved settings."""
        pid = PluginSettings.watch_project_id() or PluginSettings.default_project_id()
        module = PluginSettings.watch_module_name()

        for d in PluginSettings.watch_dirs():
            if pid and os.path.isdir(d):
                self._watcher.watch(d, pid, module or None)

        if pid and PluginSettings.auto_upload_on_processing():
            self._watcher.enable_processing_hook(pid)

    # ── Toolbar ───────────────────────────────────────────────────────────────

    def _build_toolbar(self):
        self._toolbar = self.iface.addToolBar('RakshaGIS Sync')
        self._toolbar.setObjectName('RakshaGISSyncToolbar')

        def _action(text, tooltip, slot, icon_name=''):
            ico = self._icon(icon_name)
            act = QAction(ico, text, self.iface.mainWindow())
            act.setToolTip(tooltip)
            act.triggered.connect(slot)
            self._toolbar.addAction(act)
            self._actions.append(act)
            return act

        _action('⬆ Upload',  'Upload files to RakshaGIS',
                self.show_upload_dialog, 'upload')
        _action('📋 History', 'Show upload history',
                self.show_history_dialog, 'history')
        _action('👁 Watch',   'Configure watched directories',
                self.show_settings_dialog, 'watch')
        _action('⚙ Settings', 'Plugin settings',
                self.show_settings_dialog, 'settings')

    # ── Layer context menu ────────────────────────────────────────────────────

    def _install_layer_context_menu(self):
        self._layer_menu_action = QAction('Upload to RakshaGIS…', self.iface.mainWindow())
        self._layer_menu_action.triggered.connect(self._upload_active_layer)
        self.iface.addCustomActionForLayerType(
            self._layer_menu_action, '', QgsMapLayer.VectorLayer, True
        )
        self.iface.addCustomActionForLayerType(
            self._layer_menu_action, '', QgsMapLayer.RasterLayer, True
        )

    def _uninstall_layer_context_menu(self):
        if self._layer_menu_action:
            self.iface.removeCustomActionForLayerType(self._layer_menu_action)

    # ── Dialog slots ──────────────────────────────────────────────────────────

    def show_upload_dialog(self, files=None):
        if not self._client:
            return
        dlg = UploadDialog(self._manager, self._client,
                           initial_files=files or [],
                           parent=self.iface.mainWindow())
        dlg.exec_()

    def show_settings_dialog(self):
        if not self._client:
            return
        dlg = SettingsDialog(self._client, parent=self.iface.mainWindow())
        if dlg.exec_():
            self._on_settings_saved()

    def show_history_dialog(self):
        if not self._history_dialog:
            self._history_dialog = HistoryDialog(
                self._manager.signals, parent=self.iface.mainWindow()
            )
        self._history_dialog.show()
        self._history_dialog.raise_()

    # ── Internal slots ────────────────────────────────────────────────────────

    def _upload_active_layer(self):
        layer = self.iface.activeLayer()
        if not layer:
            QMessageBox.information(
                self.iface.mainWindow(), 'No Layer',
                'Select a layer in the Layers panel first.'
            )
            return
        source = layer.source().split('|')[0]   # strip |layername=...
        if os.path.isfile(source):
            self.show_upload_dialog(files=[source])
        else:
            QMessageBox.warning(
                self.iface.mainWindow(), 'Cannot Upload',
                f'Layer source is not a local file:\n{source}'
            )

    def _on_settings_saved(self):
        """Re-apply client credentials and restart manager/watcher after settings change."""
        self._client.base_url = PluginSettings.server_url()
        self._client.username = PluginSettings.username()
        self._client.password = PluginSettings.password()
        self._client._access = None

        # Stop old worker and start fresh
        self._manager.stop()
        try:
            self._client.login()
            self._manager.start()
        except Exception as exc:
            self.iface.messageBar().pushWarning(
                'RakshaGIS Sync', f'Could not connect: {exc}'
            )
            return

        # Restart watchers
        self._watcher.stop_all()
        self._apply_saved_settings()
        self.iface.messageBar().pushSuccess(
            'RakshaGIS Sync', 'Settings saved and connection established.'
        )

    def _on_upload_finished(self, job, success: bool, message: str):
        bar = self.iface.messageBar()
        fname = os.path.basename(job.file_path)
        if success:
            bar.pushSuccess('RakshaGIS Sync', f'✓ {fname} — {message}')
        else:
            bar.pushWarning('RakshaGIS Sync', f'✗ {fname} — {message}')

    def _on_processing_upload(self, file_path: str, algorithm_id: str):
        fname = os.path.basename(file_path)
        self.iface.messageBar().pushInfo(
            'RakshaGIS Sync', f'Queued for upload: {fname} (from {algorithm_id})'
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _icon(self, name: str) -> QIcon:
        icon_path = os.path.join(os.path.dirname(__file__), 'icons', f'{name}.png')
        if os.path.isfile(icon_path):
            return QIcon(icon_path)
        return QgsApplication.getThemeIcon('/mActionAddLayer.svg')

    # ── Public API (callable from QGIS console or other plugins) ─────────────

    def upload_file(self, file_path: str, project_id: Optional[int] = None,
                    module_name: Optional[str] = None,
                    folder_id: Optional[int] = None) -> bool:
        """
        Programmatic upload from QGIS Python console or another plugin.
        Returns True if successfully enqueued.

        Example:
            from qgis.utils import plugins
            sync = plugins['rakshagis_sync']
            sync.upload_file('/outputs/change_det.tif', project_id=3,
                             module_name='Change Detection')
        """
        if not self._manager or not self._manager.is_running:
            return False
        pid = project_id or PluginSettings.default_project_id()
        if not pid:
            return False
        self._manager.enqueue(
            file_path=file_path,
            project_id=pid,
            folder_id=folder_id,
            module_name=module_name,
        )
        return True

    def upload_directory(self, directory: str, project_id: Optional[int] = None,
                         module_name: Optional[str] = None) -> int:
        """
        Upload all supported files in a directory immediately.
        Returns number of files enqueued.
        """
        if not os.path.isdir(directory):
            return 0
        pid = project_id or PluginSettings.default_project_id()
        if not pid:
            return 0
        count = 0
        for fname in os.listdir(directory):
            fpath = os.path.join(directory, fname)
            if os.path.isfile(fpath) and RakshaGISClient.is_supported(fpath):
                self._manager.enqueue(fpath, pid, module_name=module_name)
                count += 1
        return count
