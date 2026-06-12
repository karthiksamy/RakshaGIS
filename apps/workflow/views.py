from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView
from django_filters.rest_framework import DjangoFilterBackend

from django.db import connection
from django.utils import timezone

from apps.accounts.models import User
from apps.accounts.permissions import org_queryset_filter
import csv
import io

from apps.survey_projects.models import SurveyProject, SurveyArea
from .models import WorkflowStep, AuditLog, Notification, DisputeReport, MapActivityLog
from .serializers import (
    WorkflowStepSerializer, WorkflowTransitionSerializer,
    AuditLogSerializer, NotificationSerializer, DisputeReportSerializer,
    MapActivityLogSerializer,
)

# (required_from_status, new_status, role_property)
# role_property is a User property name (string) that must return True, or None for no role check.
# These operate on SurveyProject.status (legacy project-level workflow).
TRANSITIONS = {
    'forward':           (SurveyProject.DRAFT,        SurveyProject.SUBMITTED,    'can_forward'),
    're_forward':        (SurveyProject.RETURNED,      SurveyProject.SUBMITTED,    'can_forward'),
    'send_to_approver':  (SurveyProject.SUBMITTED,     SurveyProject.UNDER_REVIEW, 'can_check'),
    'return_to_sdo':     (SurveyProject.SUBMITTED,     SurveyProject.RETURNED,     'can_check'),
    'approve':           (SurveyProject.UNDER_REVIEW,  SurveyProject.APPROVED,     'can_approve'),
    'return_from_review':(SurveyProject.UNDER_REVIEW,  SurveyProject.RETURNED,     'can_approve'),
    'publish':           (SurveyProject.APPROVED,      SurveyProject.PUBLISHED,    'can_publish'),
}

# Area-level workflow transitions — same state names, but operate on SurveyArea.status.
AREA_TRANSITIONS = {
    'forward':           (SurveyArea.DRAFT,        SurveyArea.SUBMITTED,    'can_forward'),
    're_forward':        (SurveyArea.RETURNED,      SurveyArea.SUBMITTED,    'can_forward'),
    'send_to_approver':  (SurveyArea.SUBMITTED,     SurveyArea.UNDER_REVIEW, 'can_check'),
    'return_to_sdo':     (SurveyArea.SUBMITTED,     SurveyArea.RETURNED,     'can_check'),
    'approve':           (SurveyArea.UNDER_REVIEW,  SurveyArea.APPROVED,     'can_approve'),
    'return_from_review':(SurveyArea.UNDER_REVIEW,  SurveyArea.RETURNED,     'can_approve'),
    'publish':           (SurveyArea.APPROVED,      SurveyArea.PUBLISHED,    'can_publish'),
}

ACTION_MAP = {
    'forward':           WorkflowStep.FORWARD,
    're_forward':        WorkflowStep.RE_FORWARD,
    'send_to_approver':  WorkflowStep.CHECK,
    'return_to_sdo':     WorkflowStep.RETURN,
    'approve':           WorkflowStep.APPROVE,
    'return_from_review': WorkflowStep.RETURN,
    'publish':           WorkflowStep.PUBLISH,
}

TRANSITION_LABELS = {
    'forward':           'forwarded for checking',
    're_forward':        're-forwarded for checking',
    'send_to_approver':  'sent to approver',
    'return_to_sdo':     'returned for revision',
    'approve':           'approved',
    'return_from_review': 'returned from review',
    'publish':           'published',
}


def _create_final_folder(project, user):
    from apps.survey_projects.models import ProjectLayerFolder, GISFeature
    latest = ProjectLayerFolder.objects.filter(
        project=project,
        folder_type=ProjectLayerFolder.VERSION,
        is_final=False,
    ).order_by('-created_at').first()

    if not latest:
        return

    final, created = ProjectLayerFolder.objects.get_or_create(
        project=project,
        parent=latest.parent,
        folder_type=ProjectLayerFolder.VERSION,
        is_final=True,
        defaults={'name': 'Final', 'created_by': user, 'order': 999},
    )
    if created:
        for feat in GISFeature.objects.filter(folder=latest, is_deleted=False):
            feat.pk = None
            feat.id = None
            feat.folder = final
            feat.save()


def _notify_org_users(project, transition_name, actor):
    label = TRANSITION_LABELS.get(transition_name, transition_name)
    users = User.objects.filter(organisation=project.organisation).exclude(id=actor.id)
    Notification.objects.bulk_create([
        Notification(
            recipient=u,
            title=f"Project {project.project_number} {label}",
            message=f'Project "{project.name}" has been {label} by {actor.get_full_name() or actor.username}.',
            notification_type=Notification.WORKFLOW,
            project=project,
        )
        for u in users
    ])


def _run_dispute_check(area):
    """
    Run a PostGIS spatial overlap check for the given SurveyArea.

    Returns a list of dispute dicts (empty = no overlaps).
    Only checks POLYGON features against PUBLISHED survey-area projects
    from other organisations.
    """
    org_id = area.project.organisation_id
    project_id = area.project_id

    sql = """
        SELECT DISTINCT ON (sf.id, tf.id)
            sf.id                 AS source_feature_id,
            sf.layer_name         AS source_layer,
            tf.id                 AS target_feature_id,
            tf.layer_name         AS target_layer,
            tp.project_number     AS target_project,
            tp.id                 AS target_project_id,
            o.name                AS target_org,
            ROUND(
                ST_Area(ST_Transform(
                    ST_Intersection(sf.geometry, tf.geometry), 32643
                ))::numeric, 2
            )                     AS overlap_sqm
        FROM survey_projects_gisfeature sf
        JOIN survey_projects_gisfeature tf
            ON ST_Intersects(sf.geometry, tf.geometry)
           AND sf.id != tf.id
        JOIN survey_projects_surveyproject tp ON tf.project_id = tp.id
        JOIN accounts_organisation o ON tp.organisation_id = o.id
        WHERE sf.project_id      = %s
          AND sf.geometry_type   = 'POLYGON'
          AND sf.is_deleted      = false
          AND tf.geometry_type   = 'POLYGON'
          AND tf.is_deleted      = false
          AND tp.organisation_id != %s
          AND EXISTS (
              SELECT 1
              FROM survey_projects_surveyarea sa
              WHERE sa.project_id = tp.id
                AND sa.status     = 'PUBLISHED'
          )
        LIMIT 100
    """

    with connection.cursor() as cur:
        cur.execute(sql, [project_id, org_id])
        cols = [c.name for c in cur.description]
        rows = cur.fetchall()

    return [dict(zip(cols, row)) for row in rows]


class WorkflowStepViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowStepSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['project', 'survey_area', 'action']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            WorkflowStep.objects.select_related(
                'project__organisation', 'survey_area', 'actor'
            ),
            org_field='project__organisation',
        )

    @action(
        detail=False, methods=['post'],
        url_path='transition/(?P<project_pk>[^/.]+)/(?P<transition_name>[^/.]+)'
    )
    def transition(self, request, project_pk=None, transition_name=None):
        if transition_name not in TRANSITIONS:
            return Response({'detail': 'Unknown transition.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            project = SurveyProject.objects.get(pk=project_pk)
        except SurveyProject.DoesNotExist:
            return Response({'detail': 'Project not found.'}, status=status.HTTP_404_NOT_FOUND)

        user = request.user

        # Org-scope check: SUPERADMIN bypasses, everyone else must match their org
        if user.role != User.SUPERADMIN and project.organisation != user.organisation:
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)

        required_status, new_status, role_attr = TRANSITIONS[transition_name]

        if role_attr and not getattr(user, role_attr, False):
            return Response(
                {'detail': 'Your role does not allow this transition.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        if project.status != required_status:
            return Response(
                {
                    'detail': (
                        f'Project must be in "{required_status}" state for this transition. '
                        f'Current state: "{project.status}".'
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = WorkflowTransitionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        project.status = new_status
        project.save(update_fields=['status', 'updated_at'])

        WorkflowStep.objects.create(
            project=project,
            action=ACTION_MAP[transition_name],
            actor=request.user,
            remarks=serializer.validated_data['remarks'],
        )

        if transition_name == 'approve':
            _create_final_folder(project, request.user)

        _notify_org_users(project, transition_name, request.user)

        return Response({
            'status': new_status,
            'detail': f'Project {TRANSITION_LABELS[transition_name]}.',
        })

    @action(
        detail=False, methods=['post'],
        url_path='area-transition/(?P<area_pk>[^/.]+)/(?P<transition_name>[^/.]+)'
    )
    def area_transition(self, request, area_pk=None, transition_name=None):
        """Perform a workflow transition on a SurveyArea (not a project)."""
        if transition_name not in AREA_TRANSITIONS:
            return Response({'detail': 'Unknown transition.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            area = SurveyArea.objects.select_related('project__organisation').get(pk=area_pk)
        except SurveyArea.DoesNotExist:
            return Response({'detail': 'Survey area not found.'}, status=status.HTTP_404_NOT_FOUND)

        user = request.user
        if user.role != User.SUPERADMIN and area.project.organisation != user.organisation:
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)

        required_status, new_status, role_attr = AREA_TRANSITIONS[transition_name]

        if role_attr and not getattr(user, role_attr, False):
            return Response(
                {'detail': 'Your role does not allow this transition.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        if area.status != required_status:
            return Response(
                {
                    'detail': (
                        f'Survey area must be in "{required_status}" state for this transition. '
                        f'Current state: "{area.status}".'
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # -- Dispute check for submission transitions --
        if transition_name in ('forward', 're_forward'):
            force = str(request.data.get('force_submit', '')).lower() in ('true', '1', 'yes')
            if not force:
                disputes = _run_dispute_check(area)
                if disputes:
                    report = DisputeReport.objects.create(
                        survey_area=area,
                        checked_by=user,
                        status=DisputeReport.HAS_DISPUTES,
                        disputes=disputes,
                    )
                    return Response(
                        {
                            'detail': (
                                f'{len(disputes)} spatial overlap(s) detected with published '
                                f'features from other organisations. Review and acknowledge to proceed.'
                            ),
                            'dispute_count': len(disputes),
                            'dispute_report_id': report.id,
                            'disputes': disputes,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )

        serializer = WorkflowTransitionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        area.status = new_status
        area.save(update_fields=['status', 'updated_at'])

        WorkflowStep.objects.create(
            survey_area=area,
            project=area.project,
            action=ACTION_MAP[transition_name],
            actor=request.user,
            remarks=serializer.validated_data['remarks'],
        )

        # Take a workflow snapshot at every state transition so users can
        # see exactly what the area looked like at each review milestone.
        try:
            from apps.survey_projects.views import _take_snapshot
            from apps.survey_projects.models import SurveyAreaSnapshot
            _take_snapshot(
                area, request.user, SurveyAreaSnapshot.WORKFLOW,
                label=f'{TRANSITION_LABELS.get(transition_name, transition_name)} → {new_status}',
            )
        except Exception:
            pass  # snapshot failure must never block the workflow

        if transition_name == 'approve':
            _create_final_folder(area.project, request.user)
            from apps.survey_projects.models import ReviewAnnotation
            ReviewAnnotation.objects.filter(survey_area=area).delete()

        # Notify org users about the area status change
        label = TRANSITION_LABELS.get(transition_name, transition_name)
        users = User.objects.filter(organisation=area.project.organisation).exclude(id=user.id)
        Notification.objects.bulk_create([
            Notification(
                recipient=u,
                title=f"Survey Area '{area.name}' {label}",
                message=(
                    f'Survey area "{area.name}" in project "{area.project.name}" '
                    f'has been {label} by {user.get_full_name() or user.username}.'
                ),
                notification_type=Notification.WORKFLOW,
                project=area.project,
            )
            for u in users
        ])

        return Response({
            'status': new_status,
            'detail': f'Survey area {TRANSITION_LABELS[transition_name]}.',
        })

    @action(
        detail=False, methods=['get', 'post'],
        url_path='dispute-check/(?P<area_pk>[^/.]+)',
        permission_classes=[permissions.IsAuthenticated],
    )
    def dispute_check(self, request, area_pk=None):
        """
        GET  — return the latest DisputeReport for this area (or 204 if none).
        POST — run a fresh dispute check synchronously and return the result.
        """
        try:
            area = SurveyArea.objects.select_related('project__organisation').get(pk=area_pk)
        except SurveyArea.DoesNotExist:
            return Response({'detail': 'Survey area not found.'}, status=status.HTTP_404_NOT_FOUND)

        user = request.user
        if user.role != User.SUPERADMIN and area.project.organisation != user.organisation:
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)

        if request.method == 'GET':
            report = DisputeReport.objects.filter(survey_area=area).first()
            if not report:
                return Response(status=status.HTTP_204_NO_CONTENT)
            return Response(DisputeReportSerializer(report).data)

        # POST — run fresh check
        disputes = _run_dispute_check(area)
        report_status = DisputeReport.HAS_DISPUTES if disputes else DisputeReport.CLEAN
        report = DisputeReport.objects.create(
            survey_area=area,
            checked_by=user,
            status=report_status,
            disputes=disputes,
        )
        return Response(DisputeReportSerializer(report).data, status=status.HTTP_201_CREATED)

    @action(
        detail=False, methods=['post'],
        url_path='dispute-check/(?P<area_pk>[^/.]+)/acknowledge',
        permission_classes=[permissions.IsAuthenticated],
    )
    def acknowledge_disputes(self, request, area_pk=None):
        """Mark the latest dispute report as acknowledged so the area can be force-submitted."""
        try:
            area = SurveyArea.objects.select_related('project__organisation').get(pk=area_pk)
        except SurveyArea.DoesNotExist:
            return Response({'detail': 'Survey area not found.'}, status=status.HTTP_404_NOT_FOUND)

        user = request.user
        if user.role != User.SUPERADMIN and area.project.organisation != user.organisation:
            return Response({'detail': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)

        report = DisputeReport.objects.filter(
            survey_area=area, status=DisputeReport.HAS_DISPUTES
        ).first()
        if not report:
            return Response({'detail': 'No dispute report to acknowledge.'}, status=status.HTTP_404_NOT_FOUND)

        report.acknowledged = True
        report.acknowledged_by = user
        report.acknowledged_at = timezone.now()
        report.save(update_fields=['acknowledged', 'acknowledged_by', 'acknowledged_at'])
        return Response({'detail': 'Disputes acknowledged.'})


class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AuditLogSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['action', 'model_name', 'user']
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.role == User.SUPERADMIN:
            return AuditLog.objects.select_related('user').all()
        # PDDE oversight is limited to its own command subtree — global audit
        # logs would leak other commands' activity.
        if user.role == User.PDDE_VIEWER and user.organisation:
            return AuditLog.objects.select_related('user').filter(
                user__organisation_id__in=user.organisation.get_subtree_ids()
            )
        return AuditLog.objects.select_related('user').filter(user=user)


class NotificationViewSet(viewsets.ModelViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'patch', 'post', 'head', 'options']

    def get_queryset(self):
        return Notification.objects.filter(recipient=self.request.user).select_related('project')

    @action(detail=False, methods=['post'])
    def mark_all_read(self, request):
        updated = Notification.objects.filter(recipient=request.user, is_read=False).update(is_read=True)
        return Response({'marked_read': updated})

    @action(detail=False, methods=['get'])
    def unread_count(self, request):
        count = Notification.objects.filter(recipient=request.user, is_read=False).count()
        return Response({'unread': count})


# ── Bulk Status Transition ────────────────────────────────────────────────────

class BulkTransitionView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        project_ids = request.data.get('project_ids', [])
        transition_name = request.data.get('transition', '')
        remarks = request.data.get('remarks', '')

        if not project_ids or transition_name not in TRANSITIONS:
            return Response(
                {'detail': 'Provide valid project_ids and transition name.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user = request.user
        required_status, new_status, role_attr = TRANSITIONS[transition_name]

        if role_attr and not getattr(user, role_attr, False):
            return Response(
                {'detail': f'Your role ({user.get_role_display()}) cannot perform "{transition_name}".'},
                status=status.HTTP_403_FORBIDDEN,
            )

        success_ids = []
        failed = []

        for pid in project_ids:
            try:
                if user.is_superadmin:
                    project = SurveyProject.objects.get(pk=pid)
                else:
                    project = SurveyProject.objects.get(pk=pid, organisation=user.organisation)
            except SurveyProject.DoesNotExist:
                failed.append({'id': pid, 'reason': 'Not found or permission denied'})
                continue

            if project.status != required_status:
                failed.append({
                    'id': pid,
                    'reason': f'Expected status {required_status}, got {project.status}',
                })
                continue

            project.status = new_status
            project.save(update_fields=['status', 'updated_at'])
            WorkflowStep.objects.create(
                project=project,
                action=ACTION_MAP[transition_name],
                actor=user,
                remarks=remarks,
            )
            if transition_name == 'approve':
                _create_final_folder(project, user)
            _notify_org_users(project, transition_name, user)
            success_ids.append(pid)

        return Response({
            'transitioned': len(success_ids),
            'failed': len(failed),
            'success_ids': success_ids,
            'errors': failed,
        })


class MapActivityLogViewSet(viewsets.ModelViewSet):
    """
    Map activity audit log — records every user action on the map viewer.
    GET  /workflow/map-activity/           — list (filterable)
    POST /workflow/map-activity/           — create a log entry (frontend)
    GET  /workflow/map-activity/export/    — CSV export for audit
    """
    serializer_class = MapActivityLogSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['action', 'project', 'survey_area', 'user']

    def get_permissions(self):
        if self.action == 'create':
            return [permissions.IsAuthenticated()]
        return [permissions.IsAuthenticated()]

    def get_queryset(self):
        user = self.request.user
        qs = MapActivityLog.objects.select_related(
            'user__organisation', 'project', 'survey_area',
        )
        # SUPERADMIN sees all; everyone else sees their own org's logs
        if user.role != User.SUPERADMIN:
            org = getattr(user, 'organisation', None)
            if org:
                qs = qs.filter(user__organisation=org)
            else:
                qs = qs.filter(user=user)

        # Date range filter
        date_from = self.request.query_params.get('date_from')
        date_to   = self.request.query_params.get('date_to')
        if date_from:
            qs = qs.filter(timestamp__date__gte=date_from)
        if date_to:
            qs = qs.filter(timestamp__date__lte=date_to)

        return qs

    def perform_create(self, serializer):
        ip = (
            self.request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip()
            or self.request.META.get('REMOTE_ADDR')
        )
        serializer.save(user=self.request.user, ip_address=ip or None)

    @action(detail=False, methods=['get'], url_path='export')
    def export(self, request):
        """Download all matching logs as CSV for audit submission."""
        qs = self.filter_queryset(self.get_queryset())
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            'Timestamp', 'User', 'Organisation', 'Action', 'Activity',
            'Project', 'Survey Area', 'Feature ID', 'Layer', 'IP Address', 'Detail',
        ])
        for log in qs.iterator():
            writer.writerow([
                log.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
                log.user.get_full_name() if log.user else '',
                getattr(getattr(log.user, 'organisation', None), 'name', '') if log.user else '',
                log.get_action_display(),
                log.activity_label,
                log.project.name if log.project else '',
                log.survey_area.name if log.survey_area else '',
                log.feature_id or '',
                log.layer_name,
                log.ip_address or '',
                str(log.detail) if log.detail else '',
            ])
        buf.seek(0)
        from django.http import HttpResponse
        response = HttpResponse(buf.read(), content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="map_activity_audit.csv"'
        return response


class EncroachmentSummaryView(APIView):
    """
    GET  /api/workflow/encroachment-summary/  — list of active unacknowledged dispute reports
    POST /api/workflow/encroachment-summary/  — acknowledge all (body: {area_ids: [...]})
    """
    permission_classes = [permissions.IsAuthenticated]

    def _base_qs(self, user):
        qs = DisputeReport.objects.filter(
            status=DisputeReport.HAS_DISPUTES, acknowledged=False
        ).select_related('survey_area__project__organisation').order_by('-checked_at')
        from apps.survey_projects.access import hq_level
        if user.organisation:
            # HQ (DGDE/PDDE) users including org-attached superadmins: own org only.
            if hq_level(user):
                org_ids = [user.organisation_id]
            elif user.is_superadmin:
                # Global superadmin (no HQ restriction): sees all
                org_ids = None
            else:
                org_ids = user.organisation.get_subtree_ids()
            if org_ids is not None:
                qs = qs.filter(survey_area__project__organisation_id__in=org_ids)
        elif not user.is_superadmin:
            qs = qs.none()
        return qs

    def get(self, request):
        qs = self._base_qs(request.user)
        total = qs.count()
        items = []
        seen_projects = set()
        for r in qs[:50]:
            pid = r.survey_area.project_id
            items.append({
                'report_id':      r.id,
                'survey_area_id': r.survey_area_id,
                'survey_area':    r.survey_area.name,
                'project_id':     pid,
                'project_number': r.survey_area.project.project_number,
                'org':            r.survey_area.project.organisation.name,
                'dispute_count':  len(r.disputes),
                'total_overlap_sqm': round(
                    sum(float(d.get('overlap_sqm') or 0) for d in r.disputes), 2
                ),
                'overlapping_orgs': list({d.get('target_org', '') for d in r.disputes if d.get('target_org')}),
                'checked_at':     r.checked_at.isoformat(),
                'is_duplicate':   pid in seen_projects,
            })
            seen_projects.add(pid)

        total_overlap = sum(i['total_overlap_sqm'] for i in items)
        return Response({
            'total': total,
            'total_overlap_sqm': round(total_overlap, 2),
            'items': items,
        })

    def post(self, request):
        """Acknowledge selected reports (or all if area_ids omitted)."""
        area_ids = request.data.get('area_ids')
        qs = self._base_qs(request.user)
        if area_ids:
            qs = qs.filter(survey_area_id__in=area_ids)
        now = timezone.now()
        updated = qs.update(
            acknowledged=True,
            acknowledged_by=request.user,
            acknowledged_at=now,
        )
        return Response({'acknowledged': updated})
