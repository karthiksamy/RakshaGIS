"""
RakshaGIS Sync — QGIS Plugin
Uploads processing outputs to the RakshaGIS server automatically.
"""


def classFactory(iface):
    from .plugin import RakshaGISSyncPlugin
    return RakshaGISSyncPlugin(iface)
