from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0009_raster_type_shapefile_folder_fk'),
    ]

    operations = [
        migrations.AlterField(
            model_name='projectlayerfolder',
            name='folder_type',
            field=models.CharField(
                max_length=10,
                choices=[
                    ('COMMON',    'Common Layer'),
                    ('BOUNDARY',  'Admin Boundary'),
                    ('PHASE',     'Phase'),
                    ('ZONE',      'Pockets'),
                    ('YEAR',      'Year'),
                    ('VERSION',   'Version'),
                    ('DOC',       'Document Folder'),
                    ('SHAPEFILE', 'Shape Files Folder'),
                    ('RASTER',    'Raster / GeoTIFF Folder'),
                    ('OTHERS',    'Others'),
                ],
            ),
        ),
    ]
