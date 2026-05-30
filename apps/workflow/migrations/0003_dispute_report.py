import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('workflow', '0002_workflowstep_surveyarea_fk'),
        ('survey_projects', '0016_survey_area_access_request'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='DisputeReport',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('checked_at', models.DateTimeField(auto_now_add=True)),
                ('status', models.CharField(choices=[('CLEAN', 'Clean'), ('HAS_DISPUTES', 'Has Disputes')], default='CLEAN', max_length=15)),
                ('disputes', models.JSONField(default=list)),
                ('acknowledged', models.BooleanField(default=False)),
                ('acknowledged_at', models.DateTimeField(blank=True, null=True)),
                ('survey_area', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='dispute_reports', to='survey_projects.surveyarea')),
                ('checked_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('acknowledged_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-checked_at'],
            },
        ),
    ]
