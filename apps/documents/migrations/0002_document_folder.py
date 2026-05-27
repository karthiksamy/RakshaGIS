from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('documents', '0001_initial'),
        ('survey_projects', '0005_rename_survey_proj_proj_due_idx_survey_proj_project_b1855f_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='document',
            name='folder',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='documents',
                to='survey_projects.projectlayerfolder',
            ),
        ),
    ]
