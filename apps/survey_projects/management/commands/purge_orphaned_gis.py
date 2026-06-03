"""
Purge GIS data that was orphaned by survey-area deletions made before the
cascading-delete fix. Such rows have folder=NULL (their folder tree was removed,
but the FileField/ForeignKey relations are SET_NULL) and therefore keep showing
on the project map under "All Areas".

Dry-run by default — prints counts. Pass --apply to actually delete. Scope with
--project <id> to limit to one project.

Examples:
    python manage.py purge_orphaned_gis                 # dry-run, all projects
    python manage.py purge_orphaned_gis --project 1     # dry-run, project 1
    python manage.py purge_orphaned_gis --project 1 --apply
"""
from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = 'Delete orphaned (folder=NULL) GIS features, rasters, shapefiles and documents.'

    def add_arguments(self, parser):
        parser.add_argument('--project', type=int, default=None,
                            help='Limit to a single project id.')
        parser.add_argument('--apply', action='store_true',
                            help='Actually delete (default is a dry-run).')
        parser.add_argument('--include-docs', action='store_true',
                            help='Also delete folder-less Documents (off by default).')

    def handle(self, *args, **opts):
        from apps.survey_projects.models import GISFeature, GeoTiffLayer
        from apps.documents.models import Document

        project_id = opts['project']
        apply = opts['apply']

        def scoped(qs):
            qs = qs.filter(folder__isnull=True)
            if project_id:
                qs = qs.filter(project_id=project_id)
            return qs

        feats = scoped(GISFeature.objects.all())
        rasters = scoped(GeoTiffLayer.objects.all())
        targets = [('GIS features', feats), ('GeoTIFF rasters', rasters)]

        # Optional extras if present in this build.
        for model_path, label in (
            ('apps.survey_projects.models.ShapefileImport', 'shapefile imports'),
            ('apps.survey_projects.models.QGISUploadLog', 'QGIS upload logs'),
        ):
            try:
                mod, cls = model_path.rsplit('.', 1)
                Model = getattr(__import__(mod, fromlist=[cls]), cls)
                targets.append((label, scoped(Model.objects.all())))
            except Exception:
                pass
        if opts['include_docs']:
            targets.append(('documents', scoped(Document.objects.all())))

        self.stdout.write(self.style.WARNING(
            f"Orphaned (folder=NULL) rows{f' in project {project_id}' if project_id else ''}:"))
        total = 0
        for label, qs in targets:
            n = qs.count()
            total += n
            self.stdout.write(f'  {label:22s}: {n}')

        if total == 0:
            self.stdout.write(self.style.SUCCESS('Nothing to purge.'))
            return

        if not apply:
            self.stdout.write(self.style.NOTICE('\nDry-run — re-run with --apply to delete.'))
            return

        with transaction.atomic():
            # Delete stored files first (FileField.delete is not automatic).
            for obj in scoped(GeoTiffLayer.objects.all()):
                for fld in ('file', 'cog_file'):
                    f = getattr(obj, fld, None)
                    if f:
                        try:
                            f.delete(save=False)
                        except Exception:
                            pass
            if opts['include_docs']:
                for obj in scoped(Document.objects.all()):
                    if obj.file:
                        try:
                            obj.file.delete(save=False)
                        except Exception:
                            pass
            for label, qs in targets:
                deleted, _ = qs.delete()
                self.stdout.write(self.style.SUCCESS(f'  deleted {label}: {deleted}'))
        self.stdout.write(self.style.SUCCESS('Purge complete.'))
