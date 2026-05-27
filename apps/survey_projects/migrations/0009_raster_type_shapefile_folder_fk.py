from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0008_qgisuploadlog'),
    ]

    operations = [
        # 1. Add RASTER choice to ProjectLayerFolder.folder_type
        migrations.AlterField(
            model_name='projectlayerfolder',
            name='folder_type',
            field=models.CharField(
                max_length=10,
                choices=[
                    ('COMMON',    'Common Layer'),
                    ('BOUNDARY',  'Admin Boundary'),
                    ('PHASE',     'Phase'),
                    ('ZONE',      'Survey Area'),
                    ('YEAR',      'Year'),
                    ('VERSION',   'Version'),
                    ('DOC',       'Document Folder'),
                    ('SHAPEFILE', 'Shape Files Folder'),
                    ('RASTER',    'Raster / GeoTIFF Folder'),
                ],
            ),
        ),
        # 2. Add folder FK to ShapefileImport
        migrations.AddField(
            model_name='shapefileimport',
            name='folder',
            field=models.ForeignKey(
                blank=True, null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='shapefile_imports',
                to='survey_projects.projectlayerfolder',
            ),
        ),
    ]
