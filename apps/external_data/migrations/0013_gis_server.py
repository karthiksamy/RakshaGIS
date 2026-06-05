import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('external_data', '0012_externallayer_inside_render_type'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='GISServerConnection',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=200)),
                ('server_type', models.CharField(choices=[
                    ('GEOSERVER', 'GeoServer (OGC WMS / WFS / WMTS)'),
                    ('ARCGIS', 'ArcGIS REST Server'),
                    ('MAPSERVER', 'MapServer (OGC WMS / WFS)'),
                    ('QGIS', 'QGIS Server'),
                    ('GENERIC', 'Generic OGC Server'),
                ], default='GENERIC', max_length=20)),
                ('base_url', models.URLField(max_length=500)),
                ('auth_type', models.CharField(choices=[
                    ('NONE', 'No Authentication'),
                    ('BASIC', 'HTTP Basic (username + password)'),
                    ('TOKEN', 'Token / API Key (Authorization header)'),
                ], default='NONE', max_length=10)),
                ('username', models.CharField(blank=True, max_length=100)),
                ('password', models.CharField(blank=True, max_length=200)),
                ('token', models.CharField(blank=True, max_length=500)),
                ('is_active', models.BooleanField(default=True)),
                ('description', models.TextField(blank=True)),
                ('test_status', models.CharField(choices=[
                    ('UNTESTED', 'Not tested yet'),
                    ('OK', 'Connected successfully'),
                    ('ERROR', 'Connection failed'),
                ], default='UNTESTED', max_length=10)),
                ('test_message', models.TextField(blank=True)),
                ('last_tested_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('added_by', models.ForeignKey(blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['name']},
        ),
        migrations.CreateModel(
            name='GISServerLayer',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('protocol', models.CharField(choices=[
                    ('WMS', 'WMS (raster tiles)'),
                    ('WFS', 'WFS (vector features)'),
                    ('WMTS', 'WMTS (tiled raster)'),
                    ('ARCGIS_FEATURE', 'ArcGIS Feature Service (vector)'),
                    ('ARCGIS_MAP', 'ArcGIS Map Service (raster tiles)'),
                    ('XYZ', 'XYZ Tile URL template'),
                ], max_length=20)),
                ('layer_name', models.CharField(max_length=300)),
                ('display_name', models.CharField(max_length=200)),
                ('description', models.TextField(blank=True)),
                ('wms_version', models.CharField(default='1.1.1', max_length=10)),
                ('wms_format', models.CharField(default='image/png', max_length=50)),
                ('wms_params', models.JSONField(blank=True, default=dict)),
                ('wmts_matrix_set', models.CharField(blank=True, max_length=100)),
                ('arcgis_map_params', models.JSONField(blank=True, default=dict)),
                ('wfs_version', models.CharField(default='2.0.0', max_length=10)),
                ('wfs_output_fmt', models.CharField(default='application/json', max_length=80)),
                ('arcgis_query_suffix', models.CharField(default='/query', max_length=100)),
                ('geometry_type', models.CharField(blank=True, max_length=20)),
                ('style', models.JSONField(blank=True, default=dict)),
                ('classification_field', models.CharField(blank=True, max_length=63)),
                ('classification_colors', models.JSONField(blank=True, default=dict)),
                ('opacity', models.FloatField(default=1.0)),
                ('min_zoom', models.IntegerField(default=5)),
                ('is_active', models.BooleanField(default=True)),
                ('display_order', models.IntegerField(default=0)),
                ('feature_count', models.IntegerField(blank=True, null=True)),
                ('bbox', models.JSONField(blank=True, null=True)),
                ('last_synced_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('connection', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE,
                    related_name='layers', to='external_data.gisserverconnection')),
                ('added_by', models.ForeignKey(blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['display_order', 'display_name']},
        ),
    ]
