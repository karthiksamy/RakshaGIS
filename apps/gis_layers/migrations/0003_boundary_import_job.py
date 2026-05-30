import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('gis_layers', '0002_geometry_nullable'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='BoundaryImportJob',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('level', models.CharField(choices=[('state', 'State'), ('district', 'District'), ('taluk', 'Taluk'), ('village', 'Village')], max_length=10)),
                ('file', models.FileField(upload_to='boundary_imports/')),
                ('name_field', models.CharField(default='NAME', max_length=64)),
                ('code_field', models.CharField(default='CODE', max_length=64)),
                ('parent_code_field', models.CharField(blank=True, default='', max_length=64)),
                ('spatial_parent', models.BooleanField(default=False)),
                ('clear_existing', models.BooleanField(default=False)),
                ('status', models.CharField(choices=[('PENDING', 'PENDING'), ('RUNNING', 'RUNNING'), ('DONE', 'DONE'), ('FAILED', 'FAILED')], default='PENDING', max_length=10)),
                ('result', models.JSONField(blank=True, null=True)),
                ('error_log', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('uploaded_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
