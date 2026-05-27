from django.db import migrations


class Migration(migrations.Migration):
    """
    No-op migration to record the addition of DOC and SHAPEFILE folder_type
    choices on ProjectLayerFolder. CharField choices are stored only in Python;
    no database schema change is required.
    """

    dependencies = [
        ('survey_projects', '0005_rename_survey_proj_proj_due_idx_survey_proj_project_b1855f_idx'),
    ]

    operations = [
        # choices-only change — no AlterField needed; Django generates this
        # migration so the "unapplied changes" warning is suppressed.
        migrations.AlterModelOptions(
            name='projectlayerfolder',
            options={'ordering': ['order', 'name']},
        ),
    ]
