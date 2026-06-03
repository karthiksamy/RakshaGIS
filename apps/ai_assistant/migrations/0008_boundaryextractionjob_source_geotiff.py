from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('ai_assistant', '0007_remove_documentchunk_unique_doc_chunk_and_more'),
        ('survey_projects', '0003_geotiff_layer'),
    ]

    operations = [
        migrations.AddField(
            model_name='boundaryextractionjob',
            name='source_geotiff',
            field=models.ForeignKey(
                blank=True,
                help_text='Georeferenced GeoTiff layer — produces polygons with real coordinates.',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='boundary_extractions',
                to='survey_projects.geotifflayer',
            ),
        ),
    ]
