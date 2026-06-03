from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0019_geotifflayer_deo_visible_gisfeature_deo_visible_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='surveyproject',
            name='map_enabled',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='surveyarea',
            name='map_enabled',
            field=models.BooleanField(default=True),
        ),
    ]
