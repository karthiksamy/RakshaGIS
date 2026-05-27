from django.conf import settings
from django.db import models


class BrandingConfig(models.Model):
    """Singleton model — always use BrandingConfig.get_solo()."""

    app_title        = models.CharField(max_length=100, default='RakshaGIS')
    app_subtitle     = models.CharField(max_length=200, default='DGDE — Defence Estates GIS Platform')
    login_tagline    = models.CharField(max_length=300, blank=True,
                           default='Precision mapping for Defence Estate management')
    primary_color    = models.CharField(max_length=20, default='#1890ff',
                           help_text='Hex color code, e.g. #1890ff')
    logo_url         = models.CharField(max_length=500, blank=True,
                           help_text='Optional absolute or relative URL to logo image')
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Branding Config'

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return self.app_title


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
