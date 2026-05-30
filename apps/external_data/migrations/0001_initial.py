from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ExternalDatabase',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=200)),
                ('host', models.CharField(max_length=200)),
                ('port', models.IntegerField(default=5432)),
                ('database', models.CharField(max_length=100)),
                ('schema', models.CharField(default='public', max_length=50)),
                ('username', models.CharField(max_length=100)),
                ('password', models.CharField(max_length=200)),
                ('is_active', models.BooleanField(default=True)),
                ('description', models.TextField(blank=True)),
                ('test_status', models.CharField(choices=[('UNTESTED', 'Not tested yet'), ('OK', 'Connected successfully'), ('ERROR', 'Connection failed')], default='UNTESTED', max_length=10)),
                ('test_message', models.TextField(blank=True)),
                ('last_tested_at', models.DateTimeField(blank=True, null=True)),
                ('last_sync_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('added_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['name']},
        ),
        migrations.CreateModel(
            name='ExternalLayer',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('table_name', models.CharField(max_length=100)),
                ('schema_name', models.CharField(default='public', max_length=50)),
                ('display_name', models.CharField(max_length=200)),
                ('description', models.TextField(blank=True)),
                ('geometry_column', models.CharField(default='geom', max_length=50)),
                ('geometry_type', models.CharField(choices=[('POINT', 'Point'), ('LINESTRING', 'Line'), ('POLYGON', 'Polygon'), ('MULTIPOINT', 'Multi-Point'), ('MULTILINESTRING', 'Multi-Line'), ('MULTIPOLYGON', 'Multi-Polygon'), ('GEOMETRYCOLLECTION', 'Geometry Collection'), ('GEOMETRY', 'Unknown / Mixed')], default='GEOMETRY', max_length=20)),
                ('srid', models.IntegerField(default=4326)),
                ('id_column', models.CharField(default='gid', max_length=50)),
                ('label_column', models.CharField(blank=True, max_length=50)),
                ('include_columns', models.JSONField(blank=True, default=list)),
                ('style', models.JSONField(blank=True, default=dict)),
                ('min_zoom', models.IntegerField(default=5)),
                ('is_active', models.BooleanField(default=True)),
                ('display_order', models.IntegerField(default=0)),
                ('feature_count', models.IntegerField(blank=True, null=True)),
                ('bbox', models.JSONField(blank=True, null=True)),
                ('last_synced_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('database', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='layers', to='external_data.externaldatabase')),
                ('added_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['display_order', 'display_name'], 'unique_together': {('database', 'schema_name', 'table_name')}},
        ),
    ]
