from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('reports', '0003_alter_reportschedule_report_type'),
    ]

    operations = [
        migrations.AlterField(
            model_name='reportschedule',
            name='report_type',
            field=models.CharField(choices=[
                ('STATUS_SUMMARY', 'Project Status Summary'),
                ('FEATURE_EXPORT', 'Feature Data Export'),
                ('ACTIVITY_LOG', 'User Activity Log'),
                ('TERRAIN_SUMMARY', 'Terrain Analysis Summary'),
                ('AI_SUMMARY', 'AI Survey Summary'),
            ], max_length=20),
        ),
    ]
