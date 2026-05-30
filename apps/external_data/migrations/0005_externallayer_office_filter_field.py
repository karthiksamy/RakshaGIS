from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('external_data', '0003_alter_externaldatabase_database_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='externallayer',
            name='office_filter_field',
            field=models.CharField(
                blank=True, max_length=63,
                help_text='Column holding the office code used to filter rows '
                          'per logged-in office. Empty = no filter.',
            ),
        ),
    ]
