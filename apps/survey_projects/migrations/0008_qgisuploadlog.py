from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0007_alter_projectlayerfolder_folder_type'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='QGISUploadLog',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('filename', models.CharField(max_length=255)),
                ('original_path', models.CharField(blank=True, help_text='Full file path on the QGIS workstation', max_length=1000)),
                ('file_size', models.PositiveBigIntegerField(default=0)),
                ('algorithm_id', models.CharField(blank=True, help_text='QGIS Processing algorithm that generated the file', max_length=200)),
                ('module_name', models.CharField(blank=True, help_text='Module name resolved for folder routing', max_length=200)),
                ('status', models.CharField(choices=[('SUCCESS', 'Success'), ('FAILED', 'Failed'), ('SKIPPED', 'Skipped (duplicate)')], default='SUCCESS', max_length=10)),
                ('error_message', models.TextField(blank=True)),
                ('uploaded_at', models.DateTimeField(auto_now_add=True)),
                ('folder', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='qgis_uploads', to='survey_projects.projectlayerfolder')),
                ('project', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='qgis_uploads', to='survey_projects.surveyproject')),
                ('uploaded_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='qgis_uploads', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-uploaded_at'],
                'indexes': [models.Index(fields=['project', 'uploaded_at'], name='survey_proj_project_upload_idx')],
            },
        ),
    ]
