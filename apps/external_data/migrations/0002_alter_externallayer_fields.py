from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('external_data', '0001_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='externallayer',
            name='id_column',
            field=models.CharField(default='gid', help_text='Primary key column in the external table', max_length=50),
        ),
        migrations.AlterField(
            model_name='externallayer',
            name='include_columns',
            field=models.JSONField(blank=True, default=list, help_text='List of column names to include; empty = all non-geometry'),
        ),
        migrations.AlterField(
            model_name='externallayer',
            name='is_active',
            field=models.BooleanField(default=True, help_text='Shown in map viewer when True'),
        ),
        migrations.AlterField(
            model_name='externallayer',
            name='label_column',
            field=models.CharField(blank=True, help_text='Column to use as feature tooltip/label', max_length=50),
        ),
        migrations.AlterField(
            model_name='externallayer',
            name='style',
            field=models.JSONField(blank=True, default=dict, help_text='OpenLayers-compatible style: {color, fillColor, weight, opacity}'),
        ),
    ]
