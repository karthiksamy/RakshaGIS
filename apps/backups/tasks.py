"""
Backup Celery tasks.

Full backup  — Django dumpdata (all tables → JSON) → gzip → optional Fernet encrypt
Org backup   — ORM export → JSON + GeoJSON + document files → ZIP → optional encrypt

Encryption: cryptography.fernet (AES-128-CBC + HMAC-SHA256)
Key source : BACKUP_ENCRYPTION_KEY setting (URL-safe base64 32-byte key).
            Auto-generated and cached in media/backups/.backup_key if not set.
"""

import gzip
import io
import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone

from celery import shared_task
from django.conf import settings
from django.utils import timezone as dj_tz


# ── Key management ────────────────────────────────────────────────────────────

def _get_fernet():
    from cryptography.fernet import Fernet
    key = getattr(settings, 'BACKUP_ENCRYPTION_KEY', '').encode()
    if not key:
        # Auto-generate a persistent key on first use
        key_file = os.path.join(_backup_dir(), '.backup_key')
        if os.path.exists(key_file):
            with open(key_file, 'rb') as f:
                key = f.read().strip()
        else:
            key = Fernet.generate_key()
            os.makedirs(_backup_dir(), exist_ok=True)
            with open(key_file, 'wb') as f:
                f.write(key)
    return Fernet(key)


def _backup_dir() -> str:
    d = getattr(settings, 'BACKUP_DIR', os.path.join(settings.MEDIA_ROOT, 'backups'))
    os.makedirs(d, exist_ok=True)
    return d


# ── Main backup dispatcher ────────────────────────────────────────────────────

@shared_task(bind=True, max_retries=0, name='backups.run_backup')
def run_backup(self, job_id: int):
    from apps.backups.models import BackupJob

    job = BackupJob.objects.select_related('org').get(id=job_id)
    job.status = BackupJob.RUNNING
    job.save(update_fields=['status'])

    try:
        if job.backup_type == BackupJob.FULL:
            _run_full_backup(job)
        else:
            _run_org_backup(job)

        job.status = BackupJob.DONE
    except Exception as exc:
        import traceback
        job.status = BackupJob.FAILED
        job.error_log = traceback.format_exc()
    finally:
        job.completed_at = dj_tz.now()
        job.save(update_fields=['status', 'file_path', 'file_size',
                                'result', 'error_log', 'completed_at'])


# ── Full database backup ──────────────────────────────────────────────────────

def _run_full_backup(job):
    from django.core.management import call_command

    ts = datetime.now(tz=timezone.utc).strftime('%Y%m%d_%H%M%S')
    base_name = f'full_{ts}'

    # Dump all data via Django serialization
    buf = io.StringIO()
    call_command('dumpdata',
                 '--natural-foreign', '--natural-primary',
                 '--indent', '2',
                 '--exclude', 'contenttypes',
                 '--exclude', 'auth.permission',
                 '--exclude', 'sessions.session',
                 '--exclude', 'django_celery_beat',
                 stdout=buf)
    raw_bytes = buf.getvalue().encode('utf-8')

    # Gzip compress
    gz_buf = io.BytesIO()
    with gzip.GzipFile(fileobj=gz_buf, mode='wb', compresslevel=6) as gz:
        gz.write(raw_bytes)
    compressed = gz_buf.getvalue()

    # Optionally encrypt
    if job.encrypted:
        fernet = _get_fernet()
        final_bytes = fernet.encrypt(compressed)
        ext = '.json.gz.enc'
    else:
        final_bytes = compressed
        ext = '.json.gz'

    filename = base_name + ext
    file_path = os.path.join(_backup_dir(), filename)
    with open(file_path, 'wb') as f:
        f.write(final_bytes)

    job.file_path = filename
    job.file_size = os.path.getsize(file_path)
    job.result = {
        'raw_bytes': len(raw_bytes),
        'compressed_bytes': len(compressed),
        'final_bytes': len(final_bytes),
        'encrypted': job.encrypted,
    }

    # Set expiry based on schedule retention or default 30 days
    job.expires_at = dj_tz.now() + timedelta(days=_retention_days(job))


# ── Organisation / Command-level backup ──────────────────────────────────────

def _run_org_backup(job):
    from apps.accounts.models import Organisation, User
    from apps.survey_projects.models import (
        SurveyProject, SurveyArea, GISFeature, ProjectLayerFolder
    )
    from apps.workflow.models import WorkflowStep
    from apps.documents.models import Document
    from django.core.serializers import serialize

    org = job.org
    if not org:
        raise ValueError('org is required for COMMAND/OFFICE backup')

    # Resolve org IDs to include
    if job.backup_type == job.COMMAND:
        org_ids = list(Organisation.objects.filter(
            id__in=org.get_subtree_ids()
        ).values_list('id', flat=True))
    else:
        org_ids = [org.id]

    ts = datetime.now(tz=timezone.utc).strftime('%Y%m%d_%H%M%S')
    safe_code = org.code.replace('/', '_')
    base_name = f'{job.backup_type.lower()}_{safe_code}_{ts}'

    with tempfile.TemporaryDirectory() as tmpdir:
        counts = {}

        # 1. Organisations
        orgs_qs = Organisation.objects.filter(id__in=org_ids)
        _write_json(tmpdir, 'organisations.json',
                    list(orgs_qs.values()))
        counts['organisations'] = orgs_qs.count()

        # 2. Users (no passwords in plaintext — include hashed field)
        users_qs = User.objects.filter(organisation_id__in=org_ids)
        _write_json(tmpdir, 'users.json',
                    list(users_qs.values(
                        'id', 'username', 'first_name', 'last_name', 'email',
                        'role', 'organisation_id', 'is_active', 'date_joined'
                    )))
        counts['users'] = users_qs.count()

        # 3. Projects
        projects_qs = SurveyProject.objects.filter(organisation_id__in=org_ids)
        project_ids = list(projects_qs.values_list('id', flat=True))
        _write_json(tmpdir, 'projects.json', list(projects_qs.values()))
        counts['projects'] = projects_qs.count()

        # 4. Survey areas
        areas_qs = SurveyArea.objects.filter(project_id__in=project_ids)
        _write_json(tmpdir, 'survey_areas.json', list(areas_qs.values()))
        counts['survey_areas'] = areas_qs.count()

        # 5. Folders
        folders_qs = ProjectLayerFolder.objects.filter(project_id__in=project_ids)
        _write_json(tmpdir, 'folders.json', list(folders_qs.values()))
        counts['folders'] = folders_qs.count()

        # 6. GIS Features as GeoJSON
        features_qs = GISFeature.objects.filter(
            project_id__in=project_ids, is_deleted=False
        )
        geojson_features = []
        for f in features_qs.iterator(chunk_size=500):
            try:
                geom = json.loads(f.geometry.geojson)
            except Exception:
                geom = None
            geojson_features.append({
                'type': 'Feature',
                'id': f.id,
                'geometry': geom,
                'properties': {
                    'feature_id': f.feature_id,
                    'layer_name': f.layer_name,
                    'geometry_type': f.geometry_type,
                    'attributes': f.attributes,
                    'project_id': f.project_id,
                    'folder_id': f.folder_id,
                    'created_at': str(f.created_at),
                },
            })
        _write_json(tmpdir, 'features.geojson', {
            'type': 'FeatureCollection',
            'features': geojson_features,
        })
        counts['features'] = len(geojson_features)

        # 7. Workflow steps
        steps_qs = WorkflowStep.objects.filter(project_id__in=project_ids)
        _write_json(tmpdir, 'workflow_steps.json', list(steps_qs.values()))
        counts['workflow_steps'] = steps_qs.count()

        # 8. Documents (metadata) + copy files
        docs_qs = Document.objects.filter(project_id__in=project_ids)
        doc_meta = list(docs_qs.values(
            'id', 'project_id', 'folder_id', 'title', 'category',
            'file', 'file_size', 'mime_type', 'uploaded_at',
        ))
        _write_json(tmpdir, 'documents.json', doc_meta)
        counts['documents'] = docs_qs.count()

        # Copy document files into documents/ subdir
        docs_dir = os.path.join(tmpdir, 'documents')
        os.makedirs(docs_dir, exist_ok=True)
        doc_files_copied = 0
        for doc in docs_qs:
            if doc.file:
                src = os.path.join(settings.MEDIA_ROOT, doc.file.name)
                if os.path.isfile(src):
                    dst = os.path.join(docs_dir, os.path.basename(doc.file.name))
                    shutil.copy2(src, dst)
                    doc_files_copied += 1
        counts['document_files_copied'] = doc_files_copied

        # 9. Metadata header
        _write_json(tmpdir, 'metadata.json', {
            'version': '1.0',
            'backup_type': job.backup_type,
            'org_code': org.code,
            'org_name': org.name,
            'org_level': org.level,
            'included_org_ids': org_ids,
            'timestamp_utc': datetime.now(tz=timezone.utc).isoformat(),
            'counts': counts,
        })

        # 10. Package as ZIP
        zip_path = os.path.join(tmpdir, base_name + '.zip')
        with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(tmpdir):
                for fname in files:
                    if fname.endswith('.zip'):
                        continue
                    fpath = os.path.join(root, fname)
                    arcname = os.path.relpath(fpath, tmpdir)
                    zf.write(fpath, arcname)

        with open(zip_path, 'rb') as zf:
            zip_bytes = zf.read()

        # 11. Encrypt if requested
        if job.encrypted:
            fernet = _get_fernet()
            final_bytes = fernet.encrypt(zip_bytes)
            filename = base_name + '.zip.enc'
        else:
            final_bytes = zip_bytes
            filename = base_name + '.zip'

        dest_path = os.path.join(_backup_dir(), filename)
        with open(dest_path, 'wb') as f:
            f.write(final_bytes)

    job.file_path = filename
    job.file_size = os.path.getsize(dest_path)
    job.result = {**counts, 'encrypted': job.encrypted}
    job.expires_at = dj_tz.now() + timedelta(days=_retention_days(job))


# ── Scheduled backup runner ───────────────────────────────────────────────────

@shared_task(name='backups.run_scheduled_backups')
def run_scheduled_backups():
    """Called by Celery Beat (daily). Enqueues any due backup schedules."""
    from apps.backups.models import BackupJob, BackupSchedule

    now = dj_tz.now()
    current_hour = now.hour
    weekday = now.weekday()   # 0=Mon … 6=Sun
    day_of_month = now.day

    for sched in BackupSchedule.objects.filter(is_active=True):
        if sched.run_hour != current_hour:
            continue
        if sched.frequency == BackupSchedule.WEEKLY and weekday != 6:
            continue
        if sched.frequency == BackupSchedule.MONTHLY and day_of_month != 1:
            continue
        # Already ran in the last 23 hours? skip
        if sched.last_run and (now - sched.last_run).total_seconds() < 23 * 3600:
            continue

        job = BackupJob.objects.create(
            backup_type=sched.backup_type,
            org=sched.org,
            encrypted=sched.encrypted,
            schedule=sched,
        )
        run_backup.delay(job.id)

        sched.last_run = now
        sched.save(update_fields=['last_run'])


# ── Rotation ──────────────────────────────────────────────────────────────────

@shared_task(name='backups.rotate_old_backups')
def rotate_old_backups():
    """Delete backup files and records that have passed their expiry date."""
    from apps.backups.models import BackupJob

    now = dj_tz.now()
    expired = BackupJob.objects.filter(
        status=BackupJob.DONE,
        expires_at__lt=now,
    )
    for job in expired:
        if job.file_path:
            fp = os.path.join(_backup_dir(), job.file_path)
            try:
                os.remove(fp)
            except FileNotFoundError:
                pass
        job.delete()


# ── Decrypt helper (for download endpoint) ────────────────────────────────────

def decrypt_backup(file_path: str) -> bytes:
    with open(file_path, 'rb') as f:
        data = f.read()
    fernet = _get_fernet()
    return fernet.decrypt(data)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _write_json(directory: str, filename: str, data) -> None:
    with open(os.path.join(directory, filename), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, default=str, indent=2)


def _retention_days(job) -> int:
    if job.schedule_id:
        return job.schedule.retention_days
    return getattr(settings, 'BACKUP_RETENTION_DAYS', 30)
