import uuid
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0003_organisation_extended'),
        ('survey_projects', '0003_geotiff_layer'),
    ]

    operations = [
        migrations.CreateModel(
            name='TwoFactorDevice',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('secret', models.CharField(max_length=64)),
                ('is_enabled', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('confirmed_at', models.DateTimeField(blank=True, null=True)),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='two_factor', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='TwoFactorPendingAuth',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('token', models.UUIDField(default=uuid.uuid4, unique=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='pending_2fa', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-created_at']},
        ),
        migrations.CreateModel(
            name='UserSession',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('jti', models.CharField(max_length=255, unique=True)),
                ('ip_address', models.GenericIPAddressField(blank=True, null=True)),
                ('user_agent', models.CharField(blank=True, max_length=500)),
                ('device_name', models.CharField(blank=True, max_length=100)),
                ('is_revoked', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_used', models.DateTimeField(auto_now=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='sessions', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-last_used']},
        ),
        migrations.AddIndex(
            model_name='usersession',
            index=models.Index(fields=['jti'], name='accounts_us_jti_idx'),
        ),
        migrations.AddIndex(
            model_name='usersession',
            index=models.Index(fields=['user', 'is_revoked'], name='accounts_us_user_rev_idx'),
        ),
        migrations.CreateModel(
            name='LoginAuditLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('username_attempted', models.CharField(max_length=150)),
                ('success', models.BooleanField()),
                ('ip_address', models.GenericIPAddressField(blank=True, null=True)),
                ('user_agent', models.CharField(blank=True, max_length=500)),
                ('failure_reason', models.CharField(blank=True, max_length=200)),
                ('timestamp', models.DateTimeField(auto_now_add=True)),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='login_logs', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-timestamp']},
        ),
        migrations.AddIndex(
            model_name='loginauditlog',
            index=models.Index(fields=['username_attempted', 'timestamp'], name='accounts_la_user_ts_idx'),
        ),
        migrations.AddIndex(
            model_name='loginauditlog',
            index=models.Index(fields=['success', 'timestamp'], name='accounts_la_succ_ts_idx'),
        ),
        migrations.CreateModel(
            name='ExportAuditLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('export_type', models.CharField(max_length=50)),
                ('filters', models.JSONField(blank=True, default=dict)),
                ('row_count', models.PositiveIntegerField(default=0)),
                ('file_size_bytes', models.PositiveIntegerField(default=0)),
                ('timestamp', models.DateTimeField(auto_now_add=True)),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='export_logs', to=settings.AUTH_USER_MODEL)),
                ('project', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='export_logs', to='survey_projects.surveyproject')),
            ],
            options={'ordering': ['-timestamp']},
        ),
        migrations.AddIndex(
            model_name='exportauditlog',
            index=models.Index(fields=['user', 'timestamp'], name='accounts_ea_user_ts_idx'),
        ),
    ]
