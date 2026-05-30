from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0016_survey_area_access_request'),
    ]

    operations = [
        migrations.AddField(
            model_name='temporarylayer',
            name='purpose_type',
            field=models.CharField(
                max_length=50, blank=True, default='',
                help_text='NOC_WORKING_PERMISSION | PM_GATI_SHAKTI | OTHER',
            ),
        ),
        migrations.AddField(
            model_name='temporarylayer',
            name='purpose_other',
            field=models.CharField(max_length=500, blank=True),
        ),
        migrations.AddField(
            model_name='temporarylayer',
            name='land_rights_type',
            field=models.CharField(
                max_length=50, blank=True, default='',
                help_text='LICENSE | LEASE | PERMANENT_TRANSFER | OTHER',
            ),
        ),
        migrations.AddField(
            model_name='temporarylayer',
            name='land_rights_other',
            field=models.CharField(max_length=500, blank=True),
        ),
        migrations.AddField(
            model_name='temporarylayer',
            name='analysis_result',
            field=models.JSONField(
                null=True, blank=True,
                help_text='Cached spatial analysis result against DefenceParcel boundaries',
            ),
        ),
    ]
