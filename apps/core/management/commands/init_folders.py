from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Create on-disk folder structure for all existing organisations and projects.'

    def handle(self, *args, **options):
        from apps.accounts.models import Organisation
        from apps.survey_projects.models import SurveyProject
        from apps.core.folder_manager import create_org_folders, create_project_folders

        orgs = Organisation.objects.all()
        self.stdout.write(f"Creating folders for {orgs.count()} organisations...")
        for org in orgs:
            create_org_folders(org)
            self.stdout.write(f"  ✓ {org}")

        projects = SurveyProject.objects.all()
        self.stdout.write(f"Creating folders for {projects.count()} projects...")
        for project in projects:
            create_project_folders(project)
            self.stdout.write(f"  ✓ {project}")

        self.stdout.write(self.style.SUCCESS("Folder structure initialised."))
