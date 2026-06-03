from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('external_data', '0008_alter_externallayer_office_filter_field'),
    ]

    operations = [
        migrations.AddField(
            model_name='externallayer',
            name='analysis_columns',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='Columns to show in Intersecting/Nearby analysis tables; empty = first 5',
            ),
        ),
    ]
