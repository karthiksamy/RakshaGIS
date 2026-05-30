# Generated migration - alters field configurations after initial creation
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('backups', '0001_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='backupjob',
            name='id',
            field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID'),
        ),
        migrations.AlterField(
            model_name='backupjob',
            name='org',
            field=models.ForeignKey(blank=True, help_text='Target organisation for COMMAND or OFFICE backups.', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='backup_jobs', to='accounts.organisation'),
        ),
        migrations.AlterField(
            model_name='backupschedule',
            name='id',
            field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID'),
        ),
    ]
