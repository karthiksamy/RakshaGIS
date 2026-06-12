from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('reports', '0004_ai_summary_report_type'),
    ]

    operations = [
        migrations.AlterField(
            model_name='reportschedule',
            name='report_type',
            field=models.CharField(choices=[
                ('STATUS_SUMMARY',  'Project Status Summary'),
                ('FEATURE_EXPORT',  'Feature Data Export'),
                ('ACTIVITY_LOG',    'User Activity Log'),
                ('TERRAIN_SUMMARY', 'Terrain Analysis Summary'),
                ('AI_SUMMARY',      'AI Survey Summary'),
                ('SURVEY_STATS',    'Ministry Survey Statistics (PDF)'),
                ('OWNERSHIP_SUM',   'Ministry Ownership Summary (PDF)'),
                ('ENCROACHMENT',    'Ministry Encroachment Analysis (PDF)'),
            ], max_length=20),
        ),
    ]
