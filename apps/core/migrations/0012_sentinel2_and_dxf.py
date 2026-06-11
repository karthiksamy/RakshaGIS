from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0011_alter_basemapconfig_url_template'),
    ]

    operations = [
        # Sentinel-2 cache depth field on BasemapConfig
        migrations.AddField(
            model_name='basemapconfig',
            name='cache_zoom_max',
            field=models.SmallIntegerField(
                blank=True, default=13,
                help_text='Highest zoom level to pre-cache (SENTINEL2 only, 8–15 recommended).',
            ),
        ),
        # Widen provider CharField to accommodate 'SENTINEL2' (9 chars)
        migrations.AlterField(
            model_name='basemapconfig',
            name='provider',
            field=models.CharField(
                max_length=12,
                choices=[
                    ('OSM',       'OpenStreetMap'),
                    ('XYZ',       'Custom XYZ Tiles'),
                    ('WMS',       'WMS Service'),
                    ('WMTS',      'WMTS Service'),
                    ('BING',      'Bing Maps'),
                    ('BHUVAN',    'Bhuvan (ISRO India)'),
                    ('ARCGIS',    'ArcGIS Map Service'),
                    ('LOCAL_COG', 'Local Basemap (uploaded GeoTIFF)'),
                    ('SENTINEL2', 'Sentinel-2 Satellite (Copernicus, free)'),
                ],
            ),
        ),
        # DXF flag on ExportTask
        migrations.AddField(
            model_name='exporttask',
            name='include_dxf',
            field=models.BooleanField(default=False),
        ),
    ]
