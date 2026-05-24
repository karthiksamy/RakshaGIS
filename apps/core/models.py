from django.conf import settings
from django.db import models


class BasemapConfig(models.Model):
    OSM    = 'OSM'
    XYZ    = 'XYZ'
    WMS    = 'WMS'
    WMTS   = 'WMTS'
    BING   = 'BING'
    BHUVAN = 'BHUVAN'

    PROVIDER_CHOICES = [
        (OSM,    'OpenStreetMap'),
        (XYZ,    'Custom XYZ Tiles'),
        (WMS,    'WMS Service'),
        (WMTS,   'WMTS Service'),
        (BING,   'Bing Maps'),
        (BHUVAN, 'Bhuvan (ISRO India)'),
    ]

    name         = models.CharField(max_length=100)
    provider     = models.CharField(max_length=10, choices=PROVIDER_CHOICES)
    url_template = models.CharField(
        max_length=500,
        help_text='Tile URL template, e.g. https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png'
    )
    attribution  = models.CharField(max_length=300, blank=True)
    is_active    = models.BooleanField(default=True)
    is_system    = models.BooleanField(
        default=False,
        help_text='Built-in config — cannot be deleted via API'
    )
    created_by   = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='basemap_configs'
    )
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f"{self.name} ({self.get_provider_display()})"
