from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='BrandingConfig',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('app_title', models.CharField(default='RakshaGIS', max_length=100)),
                ('app_subtitle', models.CharField(default='DGDE — Defence Estates GIS Platform', max_length=200)),
                ('login_tagline', models.CharField(blank=True, default='Precision mapping for Defence Estate management', max_length=300)),
                ('primary_color', models.CharField(default='#1890ff', help_text='Hex color code, e.g. #1890ff', max_length=20)),
                ('logo_url', models.CharField(blank=True, help_text='Optional absolute or relative URL to logo image', max_length=500)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name': 'Branding Config',
            },
        ),
    ]
