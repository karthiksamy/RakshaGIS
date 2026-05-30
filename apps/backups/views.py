import os

from django.http import FileResponse
from django.utils import timezone
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.models import User
from apps.accounts.permissions import IsSuperAdmin
from .models import BackupJob, BackupSchedule
from .tasks import run_backup, rotate_old_backups, decrypt_backup, _backup_dir


class _BackupJobPermission(permissions.BasePermission):
    """
    SUPERADMIN — full CRUD on all jobs.
    PDDE/DEO/CEO/ADEO admins — read + download only, restricted to backups
    that cover their own organisation or a subtree containing their org.
    """

    ADMIN_ROLES = (User.SUPERADMIN, User.DEO_ADMIN, User.CEO_ADMIN, User.ADEO_ADMIN, 'PDDE_VIEWER')

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated
                    and request.user.role in self.ADMIN_ROLES)

    def has_object_permission(self, request, view, obj: BackupJob):
        user = request.user
        if user.role == User.SUPERADMIN:
            return True
        # Non-superadmins: only read / download, never write
        if request.method not in permissions.SAFE_METHODS and view.action != 'download':
            return False
        # Full backups are superadmin-only
        if obj.backup_type == BackupJob.FULL:
            return False
        # COMMAND backup: user's org must be in the covered subtree
        if obj.backup_type == BackupJob.COMMAND and obj.org_id:
            subtree_ids = obj.org.get_subtree_ids()
            return user.organisation_id in subtree_ids
        # OFFICE backup: user's org must match or be in subtree
        if obj.backup_type == BackupJob.OFFICE and obj.org_id:
            subtree_ids = obj.org.get_subtree_ids()
            return user.organisation_id in subtree_ids or user.organisation_id == obj.org_id
        return False


class BackupJobViewSet(viewsets.ModelViewSet):
    permission_classes = [_BackupJobPermission]
    http_method_names = ['get', 'post', 'delete', 'head', 'options']

    def get_serializer_class(self):
        from .serializers import BackupJobSerializer
        return BackupJobSerializer

    def get_queryset(self):
        user = self.request.user
        qs = BackupJob.objects.select_related('org', 'created_by', 'schedule').all()
        if user.role == User.SUPERADMIN:
            return qs
        # Non-superadmins see only DONE backups for their org subtree (no FULL backups)
        if user.organisation_id:
            subtree_ids = user.organisation.get_subtree_ids()
            return qs.filter(
                status=BackupJob.DONE,
                org_id__in=subtree_ids,
            ).exclude(backup_type=BackupJob.FULL)
        return qs.none()

    def perform_create(self, serializer):
        if self.request.user.role != User.SUPERADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied('Only SUPERADMIN can create backup jobs.')
        job = serializer.save(created_by=self.request.user)
        run_backup.delay(job.id)

    @action(detail=True, methods=['get'])
    def download(self, request, pk=None):
        job = self.get_object()
        if job.status != BackupJob.DONE or not job.file_path:
            return Response({'detail': 'Backup not ready for download.'},
                            status=status.HTTP_400_BAD_REQUEST)

        file_path = os.path.join(_backup_dir(), job.file_path)
        if not os.path.exists(file_path):
            return Response({'detail': 'Backup file not found on disk.'},
                            status=status.HTTP_404_NOT_FOUND)

        if job.encrypted:
            # Decrypt in-memory for the download
            try:
                decrypted = decrypt_backup(file_path)
            except Exception as exc:
                return Response({'detail': f'Decryption failed: {exc}'},
                                status=status.HTTP_500_INTERNAL_SERVER_ERROR)
            import io
            buf = io.BytesIO(decrypted)
            buf.seek(0)
            # Filename without .enc extension
            dl_name = job.file_path.removesuffix('.enc')
            response = FileResponse(buf, as_attachment=True, filename=dl_name)
        else:
            response = FileResponse(
                open(file_path, 'rb'), as_attachment=True, filename=job.file_path
            )
        return response

    @action(detail=False, methods=['post'], url_path='rotate')
    def rotate(self, request):
        rotate_old_backups.delay()
        return Response({'detail': 'Rotation task queued.'})

    @action(detail=False, methods=['get'], url_path='disk-usage')
    def disk_usage(self, request):
        bdir = _backup_dir()
        total = 0
        count = 0
        for fname in os.listdir(bdir):
            fp = os.path.join(bdir, fname)
            if os.path.isfile(fp) and not fname.startswith('.'):
                total += os.path.getsize(fp)
                count += 1
        return Response({
            'file_count': count,
            'total_bytes': total,
            'total_human': _human_size(total),
            'backup_dir': bdir,
        })


class BackupScheduleViewSet(viewsets.ModelViewSet):
    queryset = BackupSchedule.objects.select_related('org', 'created_by').all()
    permission_classes = [IsSuperAdmin]  # schedules are superadmin-only

    def get_serializer_class(self):
        from .serializers import BackupScheduleSerializer
        return BackupScheduleSerializer

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=['post'], url_path='run-now')
    def run_now(self, request, pk=None):
        """Immediately queue a backup for this schedule (ignores timing check)."""
        sched = self.get_object()
        job = BackupJob.objects.create(
            backup_type=sched.backup_type,
            org=sched.org,
            encrypted=sched.encrypted,
            schedule=sched,
            created_by=request.user,
        )
        run_backup.delay(job.id)
        sched.last_run = timezone.now()
        sched.save(update_fields=['last_run'])
        return Response({'job_id': job.id, 'detail': 'Backup queued.'})

    @action(detail=True, methods=['post'], url_path='toggle')
    def toggle(self, request, pk=None):
        sched = self.get_object()
        sched.is_active = not sched.is_active
        sched.save(update_fields=['is_active'])
        return Response({'is_active': sched.is_active})


def _human_size(n: int) -> str:
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024:
            return f'{n:.1f} {unit}'
        n //= 1024
    return f'{n} TB'
