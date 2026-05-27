"""
RakshaGIS REST API client.
Handles authentication, token refresh, project/folder queries, and file uploads.
All network calls use urllib (stdlib only — no requests dependency needed in QGIS).
"""

import json
import mimetypes
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Tuple


class AuthError(Exception):
    pass


class APIError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ── Multipart helper (no requests) ──────────────────────────────────────────

def _encode_multipart(fields: Dict[str, str], files: Dict[str, Tuple[str, bytes, str]]) -> Tuple[bytes, str]:
    """
    Build a multipart/form-data body.
    files: { field_name: (filename, data_bytes, content_type) }
    Returns (body_bytes, content_type_header_value)
    """
    boundary = uuid.uuid4().hex
    lines: List[bytes] = []

    for name, value in fields.items():
        lines += [
            f'--{boundary}'.encode(),
            f'Content-Disposition: form-data; name="{name}"'.encode(),
            b'',
            value.encode() if isinstance(value, str) else value,
        ]

    for name, (filename, data, ctype) in files.items():
        lines += [
            f'--{boundary}'.encode(),
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"'.encode(),
            f'Content-Type: {ctype}'.encode(),
            b'',
            data,
        ]

    lines += [f'--{boundary}--'.encode()]
    body = b'\r\n'.join(lines)
    content_type = f'multipart/form-data; boundary={boundary}'
    return body, content_type


# ── Extension → MIME ─────────────────────────────────────────────────────────

MIME_MAP = {
    '.tif':     'image/tiff',
    '.tiff':    'image/tiff',
    '.zip':     'application/zip',
    '.geojson': 'application/geo+json',
    '.json':    'application/geo+json',
    '.kml':     'application/vnd.google-earth.kml+xml',
    '.gpkg':    'application/geopackage+sqlite3',
    '.csv':     'text/csv',
    '.pdf':     'application/pdf',
    '.xlsx':    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls':     'application/vnd.ms-excel',
    '.png':     'image/png',
    '.jpg':     'image/jpeg',
    '.jpeg':    'image/jpeg',
}

# Which extensions go to import-gis-file vs upload-doc
GIS_EXTENSIONS = {'.tif', '.tiff', '.zip', '.geojson', '.json', '.kml', '.gpkg'}
DOC_EXTENSIONS = {'.csv', '.pdf', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.txt', '.docx', '.doc'}

# Sub-folder name per extension.
# Every module folder gets exactly three sub-folders:
#   Raster/    — GeoTIFF raster outputs
#   Shapefile/ — Zipped shapefiles, GeoJSON, KML, GeoPackage (all vector GIS)
#   Doc/       — CSV, PDF, XLSX, images, and any other report/document
SUBFOLDER_MAP = {
    '.tif':     'Raster',
    '.tiff':    'Raster',
    '.zip':     'Shapefile',
    '.geojson': 'Shapefile',
    '.json':    'Shapefile',
    '.kml':     'Shapefile',
    '.gpkg':    'Shapefile',
    '.csv':     'Doc',
    '.pdf':     'Doc',
    '.xlsx':    'Doc',
    '.xls':     'Doc',
    '.png':     'Doc',
    '.jpg':     'Doc',
    '.jpeg':    'Doc',
    '.docx':    'Doc',
    '.doc':     'Doc',
    '.txt':     'Doc',
}


class RakshaGISClient:
    """
    Thread-safe API client for the RakshaGIS server.
    Instantiate once, reuse across uploads.
    """

    def __init__(self, base_url: str, username: str, password: str, timeout: int = 30):
        self.base_url = base_url.rstrip('/')
        self.username = username
        self.password = password
        self.timeout = timeout
        self._access: Optional[str] = None
        self._refresh: Optional[str] = None
        self._token_expiry: float = 0.0

    # ── Internal HTTP helpers ────────────────────────────────────────────────

    def _url(self, path: str) -> str:
        return f"{self.base_url}/api/{path.lstrip('/')}"

    def _headers(self, extra: Optional[Dict] = None) -> Dict[str, str]:
        h = {'Accept': 'application/json'}
        if self._access:
            h['Authorization'] = f'Bearer {self._access}'
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, path: str, data: Optional[bytes] = None,
                 headers: Optional[Dict] = None, retry_auth: bool = True) -> Any:
        url = self._url(path)
        req = urllib.request.Request(url, data=data, headers=headers or self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read()
                if body:
                    return json.loads(body)
                return {}
        except urllib.error.HTTPError as exc:
            if exc.code == 401 and retry_auth:
                self._refresh_token()
                return self._request(method, path, data, headers=self._headers(), retry_auth=False)
            body = exc.read()
            try:
                detail = json.loads(body).get('detail', body.decode())
            except Exception:
                detail = str(body)
            raise APIError(exc.code, detail) from exc

    def _get(self, path: str) -> Any:
        return self._request('GET', path)

    def _post_json(self, path: str, payload: Dict) -> Any:
        body = json.dumps(payload).encode()
        h = self._headers({'Content-Type': 'application/json'})
        return self._request('POST', path, data=body, headers=h)

    def _post_multipart(self, path: str, fields: Dict[str, str],
                        files: Dict[str, Tuple[str, bytes, str]]) -> Any:
        body, ct = _encode_multipart(fields, files)
        h = self._headers({'Content-Type': ct})
        return self._request('POST', path, data=body, headers=h)

    # ── Auth ─────────────────────────────────────────────────────────────────

    def login(self) -> None:
        """Obtain JWT tokens. Raises AuthError on failure."""
        url = self._url('accounts/auth/login/')
        payload = json.dumps({'username': self.username, 'password': self.password}).encode()
        req = urllib.request.Request(
            url, data=payload,
            headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read())
            if data.get('requires_2fa'):
                raise AuthError('This account requires 2FA — use a service account without 2FA for sync.')
            self._access = data['access']
            self._refresh = data['refresh']
            self._token_expiry = time.time() + 270  # refresh 30 s before 5-min expiry
        except urllib.error.HTTPError as exc:
            raise AuthError(f'Login failed ({exc.code}): {exc.read().decode()}') from exc

    def _refresh_token(self) -> None:
        if not self._refresh:
            self.login()
            return
        url = self._url('auth/token/refresh/')
        payload = json.dumps({'refresh': self._refresh}).encode()
        req = urllib.request.Request(
            url, data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read())
            self._access = data['access']
            self._token_expiry = time.time() + 270
        except Exception:
            self.login()

    def ensure_authenticated(self) -> None:
        if not self._access or time.time() > self._token_expiry:
            if self._refresh:
                self._refresh_token()
            else:
                self.login()

    def ping(self) -> bool:
        """Test connection and credentials. Returns True if OK."""
        try:
            self.login()
            return True
        except Exception:
            return False

    # ── Projects ─────────────────────────────────────────────────────────────

    def list_projects(self) -> List[Dict]:
        self.ensure_authenticated()
        data = self._get('projects/?page_size=200')
        return data.get('results', data) if isinstance(data, dict) else data

    def get_project(self, project_id: int) -> Dict:
        self.ensure_authenticated()
        return self._get(f'projects/{project_id}/')

    # ── Folders ──────────────────────────────────────────────────────────────

    def list_folders(self, project_id: int) -> List[Dict]:
        """Return flat list of all folders for the project."""
        self.ensure_authenticated()
        data = self._get(f'projects/folders/?project={project_id}&page_size=500')
        return data.get('results', data) if isinstance(data, dict) else data

    def create_folder(self, project_id: int, name: str,
                      folder_type: str = 'PHASE', parent_id: Optional[int] = None) -> Dict:
        self.ensure_authenticated()
        payload: Dict[str, Any] = {
            'project': project_id,
            'name': name,
            'folder_type': folder_type,
        }
        if parent_id is not None:
            payload['parent'] = parent_id
        return self._post_json('projects/folders/', payload)

    def list_folder_files(self, folder_id: int) -> Dict:
        """
        Returns {'documents': [...], 'geotiffs': [...]} for duplicate detection.
        Calls GET /api/projects/folders/{id}/files/
        """
        self.ensure_authenticated()
        return self._get(f'projects/folders/{folder_id}/files/')

    # ── File upload ──────────────────────────────────────────────────────────

    def upload_gis_file(self, folder_id: int, file_path: str,
                        layer_name: Optional[str] = None,
                        name_field: Optional[str] = None,
                        progress_callback=None) -> Dict:
        """
        Upload a GIS file (.tif, .zip, .geojson, .kml, .gpkg) to a folder.
        Calls POST /api/projects/folders/{id}/import-gis-file/
        """
        self.ensure_authenticated()
        filename = os.path.basename(file_path)
        ext = os.path.splitext(filename)[1].lower()
        mime = MIME_MAP.get(ext, 'application/octet-stream')
        lname = layer_name or os.path.splitext(filename)[0]

        with open(file_path, 'rb') as fh:
            file_data = fh.read()

        if progress_callback:
            progress_callback(30, f'Uploading {filename}…')

        fields: Dict[str, str] = {'layer_name': lname}
        if name_field:
            fields['name_field'] = name_field

        result = self._post_multipart(
            f'projects/folders/{folder_id}/import-gis-file/',
            fields=fields,
            files={'file': (filename, file_data, mime)},
        )

        if progress_callback:
            progress_callback(100, 'Upload complete')
        return result

    def upload_document(self, folder_id: int, file_path: str,
                        title: Optional[str] = None,
                        category: str = 'OTHER',
                        progress_callback=None) -> Dict:
        """
        Upload a document/report (.csv, .pdf, .xlsx, .png…) to a folder.
        Calls POST /api/projects/folders/{id}/upload-doc/
        """
        self.ensure_authenticated()
        filename = os.path.basename(file_path)
        ext = os.path.splitext(filename)[1].lower()
        mime = MIME_MAP.get(ext, 'application/octet-stream')
        doc_title = title or os.path.splitext(filename)[0]

        with open(file_path, 'rb') as fh:
            file_data = fh.read()

        if progress_callback:
            progress_callback(30, f'Uploading {filename}…')

        result = self._post_multipart(
            f'projects/folders/{folder_id}/upload-doc/',
            fields={'title': doc_title, 'category': category},
            files={'file': (filename, file_data, mime)},
        )

        if progress_callback:
            progress_callback(100, 'Upload complete')
        return result

    def upload_file(self, folder_id: int, file_path: str,
                    layer_name: Optional[str] = None,
                    progress_callback=None,
                    project_id: Optional[int] = None,
                    algorithm_id: str = '',
                    module_name: str = '') -> Dict:
        """
        Auto-route by extension to the correct upload endpoint.
        Records the upload in the server-side QGISUploadLog.
        Returns API response dict.
        """
        ext = os.path.splitext(file_path)[1].lower()
        try:
            if ext in GIS_EXTENSIONS:
                result = self.upload_gis_file(folder_id, file_path, layer_name,
                                              progress_callback=progress_callback)
            else:
                result = self.upload_document(folder_id, file_path,
                                              progress_callback=progress_callback)
            # Write server-side upload log (best-effort)
            if project_id:
                self._log_upload(project_id, folder_id, file_path,
                                 algorithm_id, module_name, 'SUCCESS')
            return result
        except Exception as exc:
            if project_id:
                self._log_upload(project_id, folder_id, file_path,
                                 algorithm_id, module_name, 'FAILED', str(exc))
            raise

    def _log_upload(self, project_id: int, folder_id: int, file_path: str,
                    algorithm_id: str, module_name: str,
                    upload_status: str, error: str = '') -> None:
        """POST to /api/projects/qgis-uploads/ — fire-and-forget."""
        try:
            payload = {
                'project': project_id,
                'folder': folder_id,
                'filename': os.path.basename(file_path),
                'original_path': file_path,
                'file_size': os.path.getsize(file_path) if os.path.isfile(file_path) else 0,
                'algorithm_id': algorithm_id or '',
                'module_name': module_name or '',
                'status': upload_status,
                'error_message': error,
            }
            self._post_json('projects/qgis-uploads/', payload)
        except Exception:
            pass   # log failure must never break the upload flow

    # ── Utility ──────────────────────────────────────────────────────────────

    @staticmethod
    def ext_to_subfolder(file_path: str) -> str:
        """Return the sub-folder name for a given file path based on extension."""
        ext = os.path.splitext(file_path)[1].lower()
        return SUBFOLDER_MAP.get(ext, 'Other')

    @staticmethod
    def is_gis_file(file_path: str) -> bool:
        ext = os.path.splitext(file_path)[1].lower()
        return ext in GIS_EXTENSIONS

    @staticmethod
    def is_supported(file_path: str) -> bool:
        ext = os.path.splitext(file_path)[1].lower()
        return ext in GIS_EXTENSIONS or ext in DOC_EXTENSIONS
