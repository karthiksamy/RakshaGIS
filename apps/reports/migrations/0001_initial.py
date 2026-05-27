from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('accounts', '0003_organisation_extended'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ReportSchedule',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=200)),
                ('report_type', models.CharField(choices=[('STATUS_SUMMARY', 'Project Status Summary'), ('FEATURE_EXPORT', 'Feature Data Export'), ('ACTIVITY_LOG', 'User Activity Log')], max_length=20)),
                ('frequency', models.CharField(choices=[('DAILY', 'Daily'), ('WEEKLY', 'Weekly'), ('MONTHLY', 'Monthly')], default='WEEKLY', max_length=10)),
                ('recipients', models.TextField(help_text='Comma-separated email addresses')),
                ('is_active', models.BooleanField(default=True)),
                ('filters', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_sent', models.DateTimeField(blank=True, null=True)),
                ('next_run', models.DateTimeField(blank=True, null=True)),
                ('created_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='report_schedules', to=settings.AUTH_USER_MODEL)),
                ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='report_schedules', to='accounts.organisation')),
            ],
            options={'ordering': ['name']},
        ),
        migrations.AddIndex(
            model_name='reportschedule',
            index=models.Index(fields=['is_active', 'next_run'], name='reports_rep_is_acti_idx'),
        ),
    ]
