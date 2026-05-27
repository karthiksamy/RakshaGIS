"""
FolderResolver — smart folder detection and auto-creation.

Target folder hierarchy inside any RakshaGIS project:

  <Project>
  └── <Module>          (PHASE type, e.g. "Change Detection")
      ├── Shapefile/    (SHAPEFILE type — .zip, .geojson, .kml, .gpkg)
      ├── Raster/       (RASTER type — .tif / .tiff via import-gis-file)
      └── Doc/          (DOC type — .csv, .pdf, .xlsx, images, reports)

Rules:
  1. If target_folder_id explicitly supplied → upload directly there.
  2. Derive the module name from algorithm_id or the module_name argument.
     Find or create a PHASE folder with that name at the project root.
  3. Under the module folder, find or create the correct sub-folder
     (Raster / Shapefile / Doc) based on file extension.
  4. Return the resolved sub-folder dict (including its 'id').
"""

from typing import Dict, List, Optional
from .api_client import RakshaGISClient

# Backend folder_type for each sub-folder name.
# 'SHAPEFILE' means the folder accepts GIS layers (import-gis-file endpoint).
# 'DOC' means the folder accepts documents (upload-doc endpoint).
_SUBFOLDER_TYPES = {
    'Raster':    'RASTER',
    'Shapefile': 'SHAPEFILE',
    'Doc':       'DOC',
}

# Mapping from QGIS algorithm ID prefixes to friendly module names
ALGORITHM_MODULE_MAP: Dict[str, str] = {
    'change':          'Change Detection',
    'classification':  'Land Use Classification',
    'landuse':         'Land Use Analysis',
    'land_use':        'Land Use Analysis',
    'raster':          'Raster Processing',
    'vector':          'Vector Processing',
    'gdal':            'GDAL Processing',
    'native':          'General Processing',
    'qgis':            'QGIS Processing',
}


def algorithm_to_module_name(algorithm_id: str) -> str:
    """
    Map a QGIS algorithm ID (e.g. 'changedetection:detectchange') to a
    human-readable module name used as the top-level folder.

    Lookup order:
      1. User-defined mapping (exact match first, then prefix match) from QgsSettings
      2. Built-in ALGORITHM_MODULE_MAP prefix match
      3. Capitalised provider name fallback
    """
    try:
        from .settings import PluginSettings
        user_map = PluginSettings.algorithm_module_map()
        # Exact match
        if algorithm_id in user_map:
            return user_map[algorithm_id]
        # Prefix match (user map)
        lower = algorithm_id.lower()
        for key, name in user_map.items():
            if key.lower() in lower:
                return name
    except Exception:
        pass

    lower = algorithm_id.lower()
    for prefix, name in ALGORITHM_MODULE_MAP.items():
        if prefix in lower:
            return name
    provider = algorithm_id.split(':')[0].replace('_', ' ').title()
    return provider or 'QGIS Output'


class FolderResolver:
    """
    Resolves or creates the correct upload folder for a file.
    Caches the flat folder list per project to minimise API calls.
    """

    def __init__(self, client: RakshaGISClient):
        self._client = client
        self._cache: Dict[int, List[Dict]] = {}

    def _folders(self, project_id: int, force_refresh: bool = False) -> List[Dict]:
        if force_refresh or project_id not in self._cache:
            self._cache[project_id] = self._client.list_folders(project_id)
        return self._cache[project_id]

    def _find(self, folders: List[Dict], name: str,
              parent_id: Optional[int] = None) -> Optional[Dict]:
        """Find a folder by name (case-insensitive) with optional parent filter."""
        for f in folders:
            if f['name'].strip().lower() == name.strip().lower():
                if parent_id is None or f.get('parent') == parent_id:
                    return f
        return None

    def _get_or_create(self, project_id: int, name: str,
                       folder_type: str, parent_id: Optional[int] = None) -> Dict:
        folders = self._folders(project_id)
        existing = self._find(folders, name, parent_id)
        if existing:
            return existing
        # Create and refresh cache
        created = self._client.create_folder(
            project_id, name, folder_type=folder_type, parent_id=parent_id
        )
        self._cache.pop(project_id, None)   # invalidate so next call fetches fresh
        return created

    def resolve(self, project_id: int, file_path: str,
                module_name: Optional[str] = None,
                algorithm_id: Optional[str] = None,
                target_folder_id: Optional[int] = None) -> Dict:
        """
        Return the target sub-folder dict (with 'id') for the given file.

        Priority:
          1. target_folder_id explicitly provided → use it directly
          2. module_name or algorithm_id provided → resolve module folder + extension sub-folder
          3. Neither → create/find a generic "Uploads" folder + extension sub-folder
        """
        import os
        from .api_client import RakshaGISClient

        sub_name = RakshaGISClient.ext_to_subfolder(file_path)
        sub_type = _SUBFOLDER_TYPES.get(sub_name, 'DOC')

        # Case 1: explicit folder given — create extension sub-folder under it
        if target_folder_id is not None:
            folders = self._folders(project_id)
            parent = next((f for f in folders if f['id'] == target_folder_id), None)
            if parent:
                return self._get_or_create(project_id, sub_name, sub_type, parent_id=target_folder_id)
            return {'id': target_folder_id}  # folder given but not found — upload directly

        # Case 2: derive module folder from algorithm_id if module_name not provided
        if not module_name and algorithm_id:
            module_name = algorithm_to_module_name(algorithm_id)

        if not module_name:
            module_name = 'Uploads'

        # Find or create module-level PHASE folder at the project root
        module_folder = self._get_or_create(project_id, module_name, 'PHASE')
        mid = module_folder['id']

        # Eagerly ensure all three standard sub-folders exist under the module.
        # This gives a consistent Shapefile / Raster / Doc structure regardless
        # of which file type is uploaded first.
        self._get_or_create(project_id, 'Shapefile', 'SHAPEFILE', parent_id=mid)
        self._get_or_create(project_id, 'Raster',    'RASTER',    parent_id=mid)
        self._get_or_create(project_id, 'Doc',       'DOC',       parent_id=mid)

        # Return the specific sub-folder that matches this file's extension
        sub_folder = self._get_or_create(project_id, sub_name, sub_type, parent_id=mid)
        return sub_folder

    def is_duplicate(self, folder_id: int, file_path: str) -> bool:
        """
        Check if a file with the same name already exists in the folder.
        Calls GET /api/projects/folders/{id}/files/ (backend endpoint).
        Returns False on any error (fail-open — allow upload).
        """
        import os
        filename = os.path.basename(file_path)
        try:
            data = self._client.list_folder_files(folder_id)
            existing_names = set()
            for doc in data.get('documents', []):
                existing_names.add(os.path.basename(doc.get('file', '') or doc.get('title', '')))
            for gt in data.get('geotiffs', []):
                existing_names.add(os.path.basename(gt.get('file', '') or gt.get('name', '')))
            return filename in existing_names
        except Exception:
            return False

    def clear_cache(self, project_id: Optional[int] = None) -> None:
        if project_id is None:
            self._cache.clear()
        else:
            self._cache.pop(project_id, None)
