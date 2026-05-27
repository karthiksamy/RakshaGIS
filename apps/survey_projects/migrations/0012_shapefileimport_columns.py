from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0011_merge_20260526_1156'),
    ]

    operations = [
        migrations.AddField(
            model_name='shapefileimport',
            name='columns',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='Attribute column names detected in the source file',
            ),
        ),
    ]
