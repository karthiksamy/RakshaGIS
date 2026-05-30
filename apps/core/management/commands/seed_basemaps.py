from django.core.management.base import BaseCommand
from django.contrib.auth import get_user_model
from apps.core.models import BasemapConfig

BASEMAPS = [
    {
        'name': 'OpenStreetMap',
        'provider': BasemapConfig.OSM,
        'url_template': 'https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'attribution': '© OpenStreetMap contributors',
        'is_system': True,
    },
    {
        'name': 'CartoDB Dark',
        'provider': BasemapConfig.XYZ,
        'url_template': 'https://cartodb-basemaps-{a-d}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png',
        'attribution': '© OpenStreetMap contributors, © CARTO',
        'is_system': True,
    },
    {
        'name': 'Esri Satellite',
        'provider': BasemapConfig.XYZ,
        'url_template': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        'attribution': 'Esri, Maxar, Earthstar Geographics',
        'is_system': True,
    },
    {
        'name': 'Bhuvan NRC',
        'provider': BasemapConfig.BHUVAN,
        'url_template': 'https://bhuvan-vec2.nrsc.gov.in/bhuvan/gwc/service/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=india_nrc&STYLE=default&TILEMATRIXSET=EPSG:900913&TILEMATRIX=EPSG:900913:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
        'attribution': 'NRSC / ISRO Bhuvan',
        'is_system': True,
    },
    {
        # Served by the local openstreetmap-tile-server container.
        # Requires one-time import: ./build.sh --import-osm
        # Tiles are served at /osm-tiles/{z}/{x}/{y}.png via nginx proxy.
        # Enable this basemap after running --import-osm.
        'name': 'Local OSM (Offline)',
        'provider': BasemapConfig.XYZ,
        'url_template': '/osm-tiles/{z}/{x}/{y}.png',
        'attribution': '© OpenStreetMap contributors (local tile server)',
        'is_system': True,
        'is_active': False,   # activate after running ./build.sh --import-osm
    },
]


class Command(BaseCommand):
    help = 'Seed default system basemaps'

    def handle(self, *args, **options):
        User = get_user_model()
        superuser = User.objects.filter(role='SUPERADMIN').first()
        if not superuser:
            self.stdout.write(self.style.WARNING('No SUPERADMIN found — skipping basemap seed'))
            return

        created = 0
        for bm in BASEMAPS:
            obj, was_created = BasemapConfig.objects.get_or_create(
                name=bm['name'],
                defaults={**bm, 'created_by': superuser},
            )
            if was_created:
                created += 1

        self.stdout.write(self.style.SUCCESS(f'Seeded {created} basemaps ({len(BASEMAPS) - created} already existed)'))
