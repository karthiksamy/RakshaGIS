"""
RakshaGIS Sync — QGIS Processing Provider.

Registers custom algorithms that appear in the QGIS Processing Toolbox
under "RakshaGIS Sync":

  UploadLayerAlgorithm      — Upload a single layer/file to RakshaGIS
  UploadDirectoryAlgorithm  — Upload all supported files in a directory
  UploadAndClassifyAlgorithm— Run a classification then auto-upload output

Usage:
  1. Added automatically when the plugin loads (in plugin.py initGui).
  2. Find algorithms in Processing Toolbox → RakshaGIS Sync.
  3. Can also be called programmatically or chained in Processing Models.
"""

import os
from typing import Any, Dict

from qgis.core import (
    QgsProcessingAlgorithm,
    QgsProcessingContext,
    QgsProcessingFeedback,
    QgsProcessingParameterFile,
    QgsProcessingParameterFolderDestination,
    QgsProcessingParameterMapLayer,
    QgsProcessingParameterNumber,
    QgsProcessingParameterString,
    QgsProcessingParameterEnum,
    QgsProcessingParameterBoolean,
    QgsProcessingOutputString,
    QgsProcessingOutputNumber,
    QgsProcessingProvider,
)
from qgis.PyQt.QtGui import QIcon


# ── Shared helper ─────────────────────────────────────────────────────────────

def _get_client_and_manager():
    """Return (client, manager) from the running plugin instance, or (None, None)."""
    try:
        from qgis.utils import plugins
        plugin = plugins.get('rakshagis_sync')
        if plugin:
            return plugin._client, plugin._manager
    except Exception:
        pass
    return None, None


# ── Algorithm: Upload Layer ───────────────────────────────────────────────────

class UploadLayerAlgorithm(QgsProcessingAlgorithm):
    """
    Uploads a map layer (or any file) to the RakshaGIS server.
    The layer source file is uploaded; in-memory layers are not supported.
    """

    INPUT      = 'INPUT'
    PROJECT_ID = 'PROJECT_ID'
    MODULE     = 'MODULE'
    SKIP_DUP   = 'SKIP_DUPLICATES'
    OUTPUT_MSG = 'OUTPUT_MESSAGE'

    def createInstance(self):
        return UploadLayerAlgorithm()

    def name(self):
        return 'upload_layer'

    def displayName(self):
        return 'Upload Layer to RakshaGIS'

    def group(self):
        return 'RakshaGIS Sync'

    def groupId(self):
        return 'rakshagis'

    def shortHelpString(self):
        return (
            'Upload a QGIS layer (vector or raster) to the RakshaGIS server.\n\n'
            'The layer source file is uploaded. '
            'Files are routed into the correct sub-folder automatically '
            'based on their extension (GeoTIFF → Raster/, Shapefile → Shapefile/, etc.).\n\n'
            'Configure the RakshaGIS Sync plugin settings first (⚙ Settings in the toolbar).'
        )

    def initAlgorithm(self, config: Dict = {}):
        self.addParameter(
            QgsProcessingParameterMapLayer(self.INPUT, 'Layer to upload')
        )
        self.addParameter(
            QgsProcessingParameterNumber(
                self.PROJECT_ID, 'RakshaGIS Project ID',
                type=QgsProcessingParameterNumber.Integer,
                optional=True, minValue=1,
                defaultValue=None,
            )
        )
        self.addParameter(
            QgsProcessingParameterString(
                self.MODULE, 'Module / folder name (e.g. "Change Detection")',
                optional=True, defaultValue='',
            )
        )
        self.addParameter(
            QgsProcessingParameterBoolean(
                self.SKIP_DUP, 'Skip if already uploaded (duplicate check)',
                defaultValue=True,
            )
        )
        self.addOutput(QgsProcessingOutputString(self.OUTPUT_MSG, 'Upload result message'))

    def processAlgorithm(self, parameters: Dict, context: QgsProcessingContext,
                         feedback: QgsProcessingFeedback) -> Dict:
        layer     = self.parameterAsLayer(parameters, self.INPUT, context)
        project_id = self.parameterAsInt(parameters, self.PROJECT_ID, context)
        module     = self.parameterAsString(parameters, self.MODULE, context).strip()
        skip_dup   = self.parameterAsBoolean(parameters, self.SKIP_DUP, context)

        if layer is None:
            raise Exception('No layer provided.')

        source = layer.source().split('|')[0]
        if not os.path.isfile(source):
            raise Exception(
                f'Layer source is not a local file and cannot be uploaded: {source}\n'
                'Save the layer to disk first.'
            )

        client, manager = _get_client_and_manager()
        if not client or not manager:
            raise Exception(
                'RakshaGIS Sync plugin is not loaded or not connected. '
                'Open the plugin settings and test the connection first.'
            )

        from .settings import PluginSettings
        pid = project_id or PluginSettings.default_project_id()
        if not pid:
            raise Exception('No Project ID provided and no default project configured in settings.')

        feedback.setProgress(10)
        feedback.pushInfo(f'Uploading: {os.path.basename(source)}')
        feedback.pushInfo(f'Project ID: {pid} | Module: {module or "(auto)"}')

        job = manager.enqueue(
            file_path=source,
            project_id=pid,
            module_name=module or None,
            skip_duplicates=skip_dup,
        )

        feedback.setProgress(50)
        feedback.pushInfo('File queued for background upload. Check the History panel for progress.')
        feedback.setProgress(100)

        return {self.OUTPUT_MSG: f'Queued: {os.path.basename(source)} → project {pid}'}


# ── Algorithm: Upload Directory ───────────────────────────────────────────────

class UploadDirectoryAlgorithm(QgsProcessingAlgorithm):
    """
    Upload all supported files from a directory to RakshaGIS.
    Supported: .tif, .tiff, .zip, .geojson, .gpkg, .kml, .csv, .pdf, .xlsx, .png, .jpg
    """

    INPUT_DIR  = 'INPUT_DIR'
    PROJECT_ID = 'PROJECT_ID'
    MODULE     = 'MODULE'
    RECURSIVE  = 'RECURSIVE'
    SKIP_DUP   = 'SKIP_DUPLICATES'
    OUTPUT_COUNT = 'OUTPUT_COUNT'

    def createInstance(self):
        return UploadDirectoryAlgorithm()

    def name(self):
        return 'upload_directory'

    def displayName(self):
        return 'Upload Directory to RakshaGIS'

    def group(self):
        return 'RakshaGIS Sync'

    def groupId(self):
        return 'rakshagis'

    def shortHelpString(self):
        return (
            'Batch-uploads all supported files from a local directory to the RakshaGIS server.\n\n'
            'Each file is routed into the correct sub-folder based on its extension.\n'
            'Enable Recursive to include sub-directories.'
        )

    def initAlgorithm(self, config: Dict = {}):
        self.addParameter(
            QgsProcessingParameterFile(
                self.INPUT_DIR, 'Directory to upload',
                behavior=QgsProcessingParameterFile.Folder,
            )
        )
        self.addParameter(
            QgsProcessingParameterNumber(
                self.PROJECT_ID, 'RakshaGIS Project ID',
                type=QgsProcessingParameterNumber.Integer,
                optional=True, minValue=1,
            )
        )
        self.addParameter(
            QgsProcessingParameterString(
                self.MODULE, 'Module / folder name',
                optional=True, defaultValue='',
            )
        )
        self.addParameter(
            QgsProcessingParameterBoolean(
                self.RECURSIVE, 'Include sub-directories', defaultValue=False
            )
        )
        self.addParameter(
            QgsProcessingParameterBoolean(
                self.SKIP_DUP, 'Skip duplicates', defaultValue=True
            )
        )
        self.addOutput(QgsProcessingOutputNumber(self.OUTPUT_COUNT, 'Number of files queued'))

    def processAlgorithm(self, parameters: Dict, context: QgsProcessingContext,
                         feedback: QgsProcessingFeedback) -> Dict:
        from .api_client import RakshaGISClient
        from .settings import PluginSettings

        directory  = self.parameterAsFile(parameters, self.INPUT_DIR, context)
        project_id = self.parameterAsInt(parameters, self.PROJECT_ID, context)
        module     = self.parameterAsString(parameters, self.MODULE, context).strip()
        recursive  = self.parameterAsBoolean(parameters, self.RECURSIVE, context)
        skip_dup   = self.parameterAsBoolean(parameters, self.SKIP_DUP, context)

        client, manager = _get_client_and_manager()
        if not client or not manager:
            raise Exception('RakshaGIS Sync plugin not connected.')

        pid = project_id or PluginSettings.default_project_id()
        if not pid:
            raise Exception('No Project ID provided.')

        # Collect files
        file_paths = []
        if recursive:
            for root, _, files in os.walk(directory):
                for f in files:
                    p = os.path.join(root, f)
                    if RakshaGISClient.is_supported(p):
                        file_paths.append(p)
        else:
            for f in os.listdir(directory):
                p = os.path.join(directory, f)
                if os.path.isfile(p) and RakshaGISClient.is_supported(p):
                    file_paths.append(p)

        feedback.pushInfo(f'Found {len(file_paths)} supported file(s) in {directory}')

        for i, fpath in enumerate(file_paths):
            if feedback.isCanceled():
                break
            manager.enqueue(
                file_path=fpath,
                project_id=pid,
                module_name=module or None,
                skip_duplicates=skip_dup,
            )
            feedback.setProgress(int((i + 1) / max(len(file_paths), 1) * 100))
            feedback.pushInfo(f'  Queued: {os.path.basename(fpath)}')

        return {self.OUTPUT_COUNT: len(file_paths)}


# ── Algorithm: Watch + Auto-sync Directory ────────────────────────────────────

class WatchDirectoryAlgorithm(QgsProcessingAlgorithm):
    """
    Start watching a directory — any new file written there is auto-uploaded.
    Runs until QGIS is closed or the watcher is removed via plugin settings.
    """

    INPUT_DIR  = 'INPUT_DIR'
    PROJECT_ID = 'PROJECT_ID'
    MODULE     = 'MODULE'
    OUTPUT_MSG = 'OUTPUT_MESSAGE'

    def createInstance(self):
        return WatchDirectoryAlgorithm()

    def name(self):
        return 'watch_directory'

    def displayName(self):
        return 'Watch Directory (Auto-sync)'

    def group(self):
        return 'RakshaGIS Sync'

    def groupId(self):
        return 'rakshagis'

    def shortHelpString(self):
        return (
            'Start watching a directory for new files. '
            'Any supported file written to the directory is automatically uploaded to RakshaGIS.\n\n'
            'The watch persists until QGIS is closed or until you remove it via '
            'the RakshaGIS Sync plugin Settings dialog.'
        )

    def initAlgorithm(self, config: Dict = {}):
        self.addParameter(
            QgsProcessingParameterFile(
                self.INPUT_DIR, 'Directory to watch',
                behavior=QgsProcessingParameterFile.Folder,
            )
        )
        self.addParameter(
            QgsProcessingParameterNumber(
                self.PROJECT_ID, 'RakshaGIS Project ID',
                type=QgsProcessingParameterNumber.Integer,
                optional=True, minValue=1,
            )
        )
        self.addParameter(
            QgsProcessingParameterString(
                self.MODULE, 'Module / folder name', optional=True, defaultValue='',
            )
        )
        self.addOutput(QgsProcessingOutputString(self.OUTPUT_MSG, 'Watch status'))

    def processAlgorithm(self, parameters: Dict, context: QgsProcessingContext,
                         feedback: QgsProcessingFeedback) -> Dict:
        from .settings import PluginSettings

        directory  = self.parameterAsFile(parameters, self.INPUT_DIR, context)
        project_id = self.parameterAsInt(parameters, self.PROJECT_ID, context)
        module     = self.parameterAsString(parameters, self.MODULE, context).strip()

        _, manager = _get_client_and_manager()
        if not manager:
            raise Exception('RakshaGIS Sync plugin not connected.')

        from qgis.utils import plugins
        plugin = plugins.get('rakshagis_sync')
        if not plugin:
            raise Exception('Plugin not found.')

        pid = project_id or PluginSettings.default_project_id()
        if not pid:
            raise Exception('No Project ID configured.')

        ok = plugin._watcher.watch(directory, pid, module or None)
        if ok:
            # Persist to settings
            dirs = PluginSettings.watch_dirs()
            if directory not in dirs:
                dirs.append(directory)
                PluginSettings.set_watch_dirs(dirs)
                PluginSettings.set_watch_project_id(pid)
            msg = f'Now watching: {directory} (project {pid})'
            feedback.pushInfo(msg)
        else:
            msg = f'Failed to watch directory: {directory}'
            feedback.reportError(msg)

        return {self.OUTPUT_MSG: msg}


# ── Provider ──────────────────────────────────────────────────────────────────

class RakshaGISProvider(QgsProcessingProvider):

    def __init__(self):
        super().__init__()

    def id(self):
        return 'rakshagis'

    def name(self):
        return 'RakshaGIS Sync'

    def longName(self):
        return 'RakshaGIS Sync — Upload & Watch'

    def icon(self):
        icon_path = os.path.join(os.path.dirname(__file__), 'icons', 'rakshagis.png')
        if os.path.isfile(icon_path):
            return QIcon(icon_path)
        return super().icon()

    def loadAlgorithms(self):
        self.addAlgorithm(UploadLayerAlgorithm())
        self.addAlgorithm(UploadDirectoryAlgorithm())
        self.addAlgorithm(WatchDirectoryAlgorithm())
