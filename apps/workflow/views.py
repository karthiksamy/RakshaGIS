from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django_filters.rest_framework import DjangoFilterBackend

from apps.accounts.models import User
from apps.accounts.permissions import org_queryset_filter
from apps.survey_projects.models import SurveyProject
from .models import WorkflowStep, AuditLog, Notification
from .serializers import (
    WorkflowStepSerializer, WorkflowTransitionSerializer,
    AuditLogSerializer, NotificationSerializer,
)

# (required_from_status, new_status, role_property)
# role_property is a User property name (string) that must return True, or None for no role check.
TRANSITIONS = {
    # SDO forwards a draft project to the Checker
    'forward': (SurveyProject.DRAFT, SurveyProject.SUBMITTED, 'can_forward'),
    # SDO re-forwards a returned project after addressing remarks
    're_forward': (SurveyProject.RETURNED, SurveyProject.SUBMITTED, 'can_forward'),
    # Checker reviews and sends to Approver
    'send_to_approver': (SurveyProject.SUBMITTED, SurveyProject.UNDER_REVIEW, 'can_check'),
    # Checker returns to SDO with remarks
    'return_to_sdo': (SurveyProject.SUBMITTED, SurveyProject.RETURNED, 'can_check'),
    # Approver approves the project
    'approve': (SurveyProject.UNDER_REVIEW, SurveyProject.APPROVED, 'can_approve'),
    # Approver returns with remarks
    'return_from_review': (SurveyProject.UNDER_REVIEW, SurveyProject.RETURNED, 'can_approve'),
    # DEO Admin publishes an approved project
    'publish': (SurveyProject.APPROVED, SurveyProject.PUBLISHED, 'can_publish'),
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


class WorkflowStepViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WorkflowStepSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['project', 'action']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            WorkflowStep.objects.select_related('project__organisation', 'actor'),
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

        _notify_org_users(project, transition_name, request.user)

        return Response({
            'status': new_status,
            'detail': f'Project {TRANSITION_LABELS[transition_name]}.',
        })


class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AuditLogSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['action', 'model_name', 'user']
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.role in (User.SUPERADMIN, User.PDDE_VIEWER):
            return AuditLog.objects.select_related('user').all()
        return AuditLog.objects.select_related('user').filter(user=user)


class NotificationViewSet(viewsets.ModelViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'patch', 'head', 'options']

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
