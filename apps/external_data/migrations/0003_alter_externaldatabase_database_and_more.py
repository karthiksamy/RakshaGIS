from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('external_data', '0002_alter_externallayer_fields'),
    ]

    operations = [
        migrations.AlterField(
            model_name='externaldatabase',
            name='database',
            field=models.CharField(help_text='Database name', max_length=100),
        ),
        migrations.AlterField(
            model_name='externaldatabase',
            name='id',
            field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False),
        ),
        migrations.AlterField(
            model_name='externaldatabase',
            name='name',
            field=models.CharField(help_text='Friendly name, e.g. "DGDE Operational DB"', max_length=200),
        ),
        migrations.AlterField(
            model_name='externaldatabase',
            name='password',
            field=models.CharField(help_text='Stored in plain text — restrict access to super admins', max_length=200),
        ),
        migrations.AlterField(
            model_name='externaldatabase',
            name='schema',
            field=models.CharField(default='public', help_text='Default schema (usually "public")', max_length=50),
        ),
        migrations.AlterField(
            model_name='externallayer',
            name='bbox',
            field=models.JSONField(blank=True, help_text='[minLon, minLat, maxLon, maxLat] in WGS84', null=True),
        ),
        migrations.AlterField(
            model_name='externallayer',
            name='id',
            field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False),
        ),
    ]
