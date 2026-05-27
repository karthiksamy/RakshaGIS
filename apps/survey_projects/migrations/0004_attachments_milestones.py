import apps.survey_projects.models
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('survey_projects', '0003_geotiff_layer'),
    ]

    operations = [
        migrations.CreateModel(
            name='FeatureAttachment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('file', models.FileField(upload_to=apps.survey_projects.models._attachment_upload_path)),
                ('original_filename', models.CharField(max_length=255)),
                ('file_size', models.PositiveIntegerField(default=0)),
                ('file_type', models.CharField(blank=True, max_length=10)),
                ('caption', models.CharField(blank=True, max_length=500)),
                ('uploaded_at', models.DateTimeField(auto_now_add=True)),
                ('feature', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='attachments', to='survey_projects.gisfeature')),
                ('uploaded_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='feature_attachments', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-uploaded_at']},
        ),
        migrations.CreateModel(
            name='ProjectMilestone',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=200)),
                ('description', models.TextField(blank=True)),
                ('start_date', models.DateField(blank=True, null=True)),
                ('due_date', models.DateField()),
                ('completed_date', models.DateField(blank=True, null=True)),
                ('status', models.CharField(choices=[('PENDING', 'Pending'), ('IN_PROGRESS', 'In Progress'), ('COMPLETED', 'Completed'), ('DELAYED', 'Delayed')], default='PENDING', max_length=15)),
                ('order', models.PositiveSmallIntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('assignee', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='milestones', to=settings.AUTH_USER_MODEL)),
                ('created_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='created_milestones', to=settings.AUTH_USER_MODEL)),
                ('project', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='milestones', to='survey_projects.surveyproject')),
            ],
            options={'ordering': ['due_date', 'order']},
        ),
        migrations.AddIndex(
            model_name='projectmilestone',
            index=models.Index(fields=['project', 'due_date'], name='survey_proj_proj_due_idx'),
        ),
    ]
