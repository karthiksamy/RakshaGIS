from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0009_rename_core_drone_upload_id_idx_core_droneu_upload__429af6_idx_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='basemapconfig',
            name='api_key',
            field=models.CharField(
                blank=True,
                max_length=500,
                help_text='API key / token for authenticated services (ArcGIS, Bing, etc.).',
            ),
        ),
        migrations.AlterField(
            model_name='basemapconfig',
            name='provider',
            field=models.CharField(
                max_length=12,
                choices=[
                    ('OSM', 'OpenStreetMap'),
                    ('XYZ', 'Custom XYZ Tiles'),
                    ('WMS', 'WMS Service'),
                    ('WMTS', 'WMTS Service'),
                    ('BING', 'Bing Maps'),
                    ('BHUVAN', 'Bhuvan (ISRO India)'),
                    ('ARCGIS', 'ArcGIS Map Service'),
                    ('LOCAL_COG', 'Local Basemap (uploaded GeoTIFF)'),
                ],
            ),
        ),
    ]
