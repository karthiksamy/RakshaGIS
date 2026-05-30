import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('accounts', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='BackupSchedule',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=100)),
                ('backup_type', models.CharField(choices=[('FULL', 'Full Database'), ('COMMAND', 'Command (PDDE subtree)'), ('OFFICE', 'Office (single org)')], max_length=10)),
                ('frequency', models.CharField(choices=[('DAILY', 'Daily'), ('WEEKLY', 'Weekly (Sunday)'), ('MONTHLY', 'Monthly (1st)')], default='DAILY', max_length=10)),
                ('run_hour', models.PositiveSmallIntegerField(default=2, help_text='UTC hour (0–23)')),
                ('encrypted', models.BooleanField(default=True)),
                ('retention_days', models.PositiveIntegerField(default=30, help_text='Delete backups older than this many days.')),
                ('is_active', models.BooleanField(default=True)),
                ('last_run', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('org', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='backup_schedules', to='accounts.organisation')),
                ('created_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='backup_schedules', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['name']},
        ),
        migrations.CreateModel(
            name='BackupJob',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('backup_type', models.CharField(choices=[('FULL', 'Full Database'), ('COMMAND', 'Command (PDDE subtree)'), ('OFFICE', 'Office (single org)')], max_length=10)),
                ('status', models.CharField(choices=[('PENDING', 'PENDING'), ('RUNNING', 'RUNNING'), ('DONE', 'DONE'), ('FAILED', 'FAILED')], default='PENDING', max_length=10)),
                ('file_path', models.CharField(blank=True, max_length=500)),
                ('file_size', models.BigIntegerField(blank=True, null=True)),
                ('encrypted', models.BooleanField(default=True)),
                ('result', models.JSONField(default=dict)),
                ('error_log', models.TextField(blank=True)),
                ('notes', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('expires_at', models.DateTimeField(blank=True, null=True)),
                ('org', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='backup_jobs', to='accounts.organisation')),
                ('created_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='backup_jobs', to=settings.AUTH_USER_MODEL)),
                ('schedule', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='jobs', to='backups.backupschedule')),
            ],
            options={'ordering': ['-created_at']},
        ),
    ]
