import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('workflow', '0003_dispute_report'),
        ('survey_projects', '__first__'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='MapActivityLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action', models.CharField(choices=[
                    ('VIEW_MAP',       'Viewed Map'),
                    ('SELECT_AREA',    'Selected Survey Area'),
                    ('TOOL_CHANGE',    'Changed Map Tool'),
                    ('CREATE_FEATURE', 'Created Feature'),
                    ('EDIT_FEATURE',   'Edited Feature'),
                    ('DELETE_FEATURE', 'Deleted Feature'),
                    ('LOCK_FEATURE',   'Locked Feature for Edit'),
                    ('IMPORT_GIS',     'Imported GIS Data'),
                    ('EXPORT_MAP',     'Exported Map'),
                    ('SUBMIT_AREA',    'Submitted Survey Area'),
                    ('RETURN_AREA',    'Returned Survey Area'),
                    ('APPROVE_AREA',   'Approved Survey Area'),
                    ('PUBLISH_AREA',   'Published Survey Area'),
                ], max_length=30)),
                ('activity_label', models.CharField(blank=True, max_length=100)),
                ('feature_id', models.IntegerField(blank=True, null=True)),
                ('layer_name', models.CharField(blank=True, max_length=100)),
                ('detail', models.JSONField(blank=True, default=dict)),
                ('ip_address', models.GenericIPAddressField(blank=True, null=True)),
                ('timestamp', models.DateTimeField(auto_now_add=True)),
                ('user', models.ForeignKey(
                    null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='map_activity_logs', to=settings.AUTH_USER_MODEL,
                )),
                ('project', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='map_activity_logs', to='survey_projects.surveyproject',
                )),
                ('survey_area', models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name='map_activity_logs', to='survey_projects.surveyarea',
                )),
            ],
            options={'ordering': ['-timestamp']},
        ),
        migrations.AddIndex(
            model_name='mapactivitylog',
            index=models.Index(fields=['user', 'timestamp'], name='workflow_map_user_ts_idx'),
        ),
        migrations.AddIndex(
            model_name='mapactivitylog',
            index=models.Index(fields=['project', 'timestamp'], name='workflow_map_proj_ts_idx'),
        ),
        migrations.AddIndex(
            model_name='mapactivitylog',
            index=models.Index(fields=['survey_area', 'timestamp'], name='workflow_map_area_ts_idx'),
        ),
        migrations.AddIndex(
            model_name='mapactivitylog',
            index=models.Index(fields=['action', 'timestamp'], name='workflow_map_action_ts_idx'),
        ),
    ]
