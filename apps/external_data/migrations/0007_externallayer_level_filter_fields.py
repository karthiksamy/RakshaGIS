from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('external_data', '0006_merge_20260530_2305'),
    ]

    operations = [
        migrations.AddField(
            model_name='externallayer',
            name='level_filter_fields',
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text='Per-level column map: '
                          '{"PDDE":"col","DEO":"col","CEO":"col","ADEO":"col"}. '
                          'Overrides office_filter_field for the matched level.',
            ),
        ),
    ]
