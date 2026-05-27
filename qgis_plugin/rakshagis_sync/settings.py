"""
Plugin settings — persisted via QgsSettings (QGIS settings store).
All keys are namespaced under 'RakshaGISSync/'.
"""

import json
from typing import Dict, List, Optional
from qgis.core import QgsSettings

_NS = 'RakshaGISSync'


def _key(k: str) -> str:
    return f'{_NS}/{k}'


class PluginSettings:

    @staticmethod
    def server_url() -> str:
        return QgsSettings().value(_key('server_url'), 'http://localhost', type=str)

    @staticmethod
    def set_server_url(v: str) -> None:
        QgsSettings().setValue(_key('server_url'), v.rstrip('/'))

    @staticmethod
    def username() -> str:
        return QgsSettings().value(_key('username'), '', type=str)

    @staticmethod
    def set_username(v: str) -> None:
        QgsSettings().setValue(_key('username'), v)

    @staticmethod
    def password() -> str:
        return QgsSettings().value(_key('password'), '', type=str)

    @staticmethod
    def set_password(v: str) -> None:
        QgsSettings().setValue(_key('password'), v)

    @staticmethod
    def default_project_id() -> Optional[int]:
        v = QgsSettings().value(_key('default_project_id'), None)
        return int(v) if v else None

    @staticmethod
    def set_default_project_id(v: Optional[int]) -> None:
        QgsSettings().setValue(_key('default_project_id'), v)

    @staticmethod
    def auto_upload_on_processing() -> bool:
        return QgsSettings().value(_key('auto_upload_on_processing'), False, type=bool)

    @staticmethod
    def set_auto_upload_on_processing(v: bool) -> None:
        QgsSettings().setValue(_key('auto_upload_on_processing'), v)

    @staticmethod
    def skip_duplicates() -> bool:
        return QgsSettings().value(_key('skip_duplicates'), True, type=bool)

    @staticmethod
    def set_skip_duplicates(v: bool) -> None:
        QgsSettings().setValue(_key('skip_duplicates'), v)

    @staticmethod
    def watch_dirs() -> List[str]:
        v = QgsSettings().value(_key('watch_dirs'), [], type=list)
        return [str(x) for x in v] if v else []

    @staticmethod
    def set_watch_dirs(dirs: List[str]) -> None:
        QgsSettings().setValue(_key('watch_dirs'), dirs)

    @staticmethod
    def watch_project_id() -> Optional[int]:
        v = QgsSettings().value(_key('watch_project_id'), None)
        return int(v) if v else None

    @staticmethod
    def set_watch_project_id(v: Optional[int]) -> None:
        QgsSettings().setValue(_key('watch_project_id'), v)

    @staticmethod
    def watch_module_name() -> str:
        return QgsSettings().value(_key('watch_module_name'), '', type=str)

    @staticmethod
    def set_watch_module_name(v: str) -> None:
        QgsSettings().setValue(_key('watch_module_name'), v)

    # ── Algorithm → Module name mapping ───────────────────────────────────────

    @staticmethod
    def algorithm_module_map() -> Dict[str, str]:
        """
        Returns user-defined mapping of algorithm_id prefix → module name.
        e.g. {'qgis:changedetection': 'Change Detection',
               'myplugin:landuse':     'Land Use Analysis'}
        Stored as JSON string in QgsSettings.
        """
        raw = QgsSettings().value(_key('algorithm_module_map'), '{}', type=str)
        try:
            return json.loads(raw)
        except Exception:
            return {}

    @staticmethod
    def set_algorithm_module_map(mapping: Dict[str, str]) -> None:
        QgsSettings().setValue(_key('algorithm_module_map'), json.dumps(mapping))
