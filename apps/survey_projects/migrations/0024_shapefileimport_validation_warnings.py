from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0023_gisfeaturehistory_surveyareasnapshot_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='shapefileimport',
            name='validation_warnings',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
