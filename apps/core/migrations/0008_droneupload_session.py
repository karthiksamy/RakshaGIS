import uuid
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0007_basemap_local_cog_drone_dataset'),
        ('survey_projects', '__first__'),
        ('accounts', '__first__'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='DroneUploadSession',
            # Django lowercases to 'droneuploadsession' for index operations
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('upload_id', models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ('original_filename', models.CharField(max_length=500)),
                ('total_size', models.BigIntegerField()),
                ('chunk_size', models.IntegerField(default=10485760)),
                ('total_chunks', models.IntegerField()),
                ('received_chunks', models.JSONField(default=list)),
                ('name', models.CharField(max_length=255)),
                ('description', models.TextField(blank=True)),
                ('data_type', models.CharField(choices=[
                    ('ORTHO_2D', '2D Orthomosaic (GeoTIFF)'),
                    ('DSM_DTM', 'DSM / DTM (Elevation Raster)'),
                    ('POINT_CLOUD', 'Point Cloud (LAS / LAZ / COPC)'),
                    ('MESH_3D', '3D Mesh / 3D Tiles'),
                ], max_length=15)),
                ('status', models.CharField(choices=[
                    ('UPLOADING', 'Chunks uploading'),
                    ('ASSEMBLING', 'Assembling chunks'),
                    ('DONE', 'Assembly complete'),
                    ('FAILED', 'Failed'),
                ], default='UPLOADING', max_length=12)),
                ('error', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('expires_at', models.DateTimeField()),
                ('organisation', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='+', to='accounts.organisation')),
                ('uploaded_by', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='+', to=settings.AUTH_USER_MODEL)),
                ('project', models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to='survey_projects.surveyproject')),
                ('folder', models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+', to='survey_projects.projectlayerfolder')),
                ('dataset', models.OneToOneField(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='upload_session', to='core.dronedataset')),
            ],
            options={'ordering': ['-created_at']},
        ),
        migrations.AddIndex(
            model_name='droneuploadsession',
            index=models.Index(fields=['upload_id'], name='core_drone_upload_id_idx'),
        ),
        migrations.AddIndex(
            model_name='droneuploadsession',
            index=models.Index(fields=['uploaded_by', 'status'], name='core_drone_user_status_idx'),
        ),
    ]
