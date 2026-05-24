from django.db.models.signals import post_save
from django.dispatch import receiver


def _on_organisation_saved(sender, instance, created, **kwargs):
    if created:
        from .folder_manager import create_org_folders
        try:
            create_org_folders(instance)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                "Could not create folders for org %s: %s", instance.code, e
            )


def _on_project_saved(sender, instance, created, **kwargs):
    if created:
        from .folder_manager import create_project_folders
        try:
            create_project_folders(instance)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                "Could not create folders for project %s: %s", instance.project_number, e
            )


# Connect signals — called from CoreConfig.ready()
def register():
    from apps.accounts.models import Organisation
    from apps.survey_projects.models import SurveyProject

    post_save.connect(_on_organisation_saved, sender=Organisation, weak=False)
    post_save.connect(_on_project_saved, sender=SurveyProject, weak=False)
