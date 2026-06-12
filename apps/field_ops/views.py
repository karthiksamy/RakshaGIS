from django.utils import timezone
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response

from apps.accounts.permissions import IsAnyAdmin, org_queryset_filter

from .models import (
    EncroachmentRecord, EncroachmentAttachment,
    FieldDiaryEntry,
    EquipmentCategory, EquipmentItem, EquipmentIssue, EquipmentMaintenance,
    SubmissionChecklist,
)
from .serializers import (
    EncroachmentRecordSerializer, EncroachmentAttachmentSerializer,
    FieldDiaryEntrySerializer,
    EquipmentCategorySerializer, EquipmentItemSerializer,
    EquipmentIssueSerializer, EquipmentMaintenanceSerializer,
    SubmissionChecklistSerializer,
)


# ─────────────────────────────────────────────────────────────────────────────
# Encroachment Register
# ─────────────────────────────────────────────────────────────────────────────

class EncroachmentRecordViewSet(viewsets.ModelViewSet):
    """
    CRUD for encroachment records.  All authenticated users can list/retrieve.
    Admins can create/edit/delete.  Records are scoped to the user's organisation.
    """
    serializer_class = EncroachmentRecordSerializer
    filter_backends  = [DjangoFilterBackend]
    filterset_fields = ['organisation', 'encroachment_type', 'status', 'defence_parcel',
                        'survey_project', 'detected_date']

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsAnyAdmin()]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return EncroachmentRecord.objects.none()
        qs = EncroachmentRecord.objects.select_related(
            'organisation', 'defence_parcel', 'survey_project',
            'detected_by', 'created_by',
        ).prefetch_related('attachments')
        return org_queryset_filter(self.request.user, qs)

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user, detected_by=self.request.user)


class EncroachmentAttachmentViewSet(viewsets.ModelViewSet):
    serializer_class = EncroachmentAttachmentSerializer
    parser_classes   = [MultiPartParser, FormParser, JSONParser]
    filter_backends  = [DjangoFilterBackend]
    filterset_fields = ['encroachment', 'file_type']
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return EncroachmentAttachment.objects.none()
        user = self.request.user
        qs   = EncroachmentAttachment.objects.select_related(
            'encroachment__organisation', 'uploaded_by'
        )
        return org_queryset_filter(user, qs, org_field='encroachment__organisation')

    def perform_create(self, serializer):
        serializer.save(uploaded_by=self.request.user)


# ─────────────────────────────────────────────────────────────────────────────
# Field Diary / DPR
# ─────────────────────────────────────────────────────────────────────────────

class FieldDiaryEntryViewSet(viewsets.ModelViewSet):
    """
    Daily Progress Report entries.
    Surveyors create and submit their own entries.
    Admins/Checkers can approve.
    Filter: ?survey_area=<id>, ?surveyor=<id>, ?date=YYYY-MM-DD, ?submitted=true|false
    """
    serializer_class = FieldDiaryEntrySerializer
    filter_backends  = [DjangoFilterBackend]
    filterset_fields = ['survey_area', 'surveyor', 'date', 'approved_by']
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return FieldDiaryEntry.objects.none()
        user = self.request.user
        qs   = FieldDiaryEntry.objects.select_related(
            'survey_area', 'survey_area__project__organisation',
            'surveyor', 'approved_by', 'created_by',
        ).prefetch_related('dprequipmentusage_set__equipment')

        # Superadmin and any admin see all within org scope
        return org_queryset_filter(user, qs, org_field='survey_area__project__organisation')

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user, surveyor=self.request.user)

    @action(detail=True, methods=['post'], url_path='submit')
    def submit(self, request, pk=None):
        """Surveyor marks DPR as submitted."""
        entry = self.get_object()
        if entry.submitted_at:
            return Response({'detail': 'Already submitted.'}, status=status.HTTP_400_BAD_REQUEST)
        entry.submitted_at = timezone.now()
        entry.save(update_fields=['submitted_at'])
        return Response(FieldDiaryEntrySerializer(entry, context={'request': request}).data)

    @action(detail=True, methods=['post'], url_path='approve',
            permission_classes=[IsAnyAdmin])
    def approve(self, request, pk=None):
        """Admin/Checker approves a submitted DPR."""
        entry = self.get_object()
        if not entry.submitted_at:
            return Response({'detail': 'DPR not yet submitted.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if entry.approved_at:
            return Response({'detail': 'Already approved.'}, status=status.HTTP_400_BAD_REQUEST)
        entry.approved_by = request.user
        entry.approved_at = timezone.now()
        entry.save(update_fields=['approved_by', 'approved_at'])
        return Response(FieldDiaryEntrySerializer(entry, context={'request': request}).data)


# ─────────────────────────────────────────────────────────────────────────────
# Survey Equipment Register
# ─────────────────────────────────────────────────────────────────────────────

class EquipmentCategoryViewSet(viewsets.ModelViewSet):
    serializer_class   = EquipmentCategorySerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsAnyAdmin()]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return EquipmentCategory.objects.none()
        return EquipmentCategory.objects.prefetch_related('items')


class EquipmentItemViewSet(viewsets.ModelViewSet):
    """
    Survey equipment inventory.  All data is stored in local PostgreSQL —
    no internet or external service required.

    Filter: ?category=<id>, ?status=AVAILABLE|ISSUED|MAINTENANCE|CONDEMNED,
            ?owned_by=<org_id>, ?current_holder=<user_id>
    """
    serializer_class = EquipmentItemSerializer
    filter_backends  = [DjangoFilterBackend]
    filterset_fields = ['category', 'status', 'owned_by', 'current_holder']

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsAnyAdmin()]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return EquipmentItem.objects.none()
        qs = EquipmentItem.objects.select_related(
            'category', 'owned_by', 'current_holder', 'created_by',
        ).prefetch_related('maintenance_records', 'issues')
        return org_queryset_filter(self.request.user, qs, org_field='owned_by')

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    # ── Issue ─────────────────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='issue',
            permission_classes=[IsAnyAdmin])
    def issue(self, request, pk=None):
        """
        Issue this equipment to a user.
        Body: {"issued_to": <user_id>, "issued_for_project": <id|null>,
               "expected_return_date": "YYYY-MM-DD"|null,
               "condition_at_issue": "GOOD|FAIR|NEEDS_ATTENTION",
               "remarks": "..."}
        """
        item = self.get_object()
        if item.status not in (EquipmentItem.STATUS_AVAILABLE,):
            return Response(
                {'detail': f'Equipment is currently {item.get_status_display()} and cannot be issued.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from apps.accounts.models import User
        issued_to_id = request.data.get('issued_to')
        if not issued_to_id:
            return Response({'detail': 'issued_to is required.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            issued_to = User.objects.get(pk=issued_to_id)
        except User.DoesNotExist:
            return Response({'detail': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)

        issue = EquipmentIssue.objects.create(
            equipment=item,
            issued_to=issued_to,
            issued_for_project_id=request.data.get('issued_for_project'),
            issued_date=timezone.now().date(),
            expected_return_date=request.data.get('expected_return_date'),
            issued_by=request.user,
            condition_at_issue=request.data.get('condition_at_issue', EquipmentIssue.CONDITION_GOOD),
            remarks=request.data.get('remarks', ''),
        )
        item.status = EquipmentItem.STATUS_ISSUED
        item.current_holder = issued_to
        item.save(update_fields=['status', 'current_holder', 'updated_at'])

        return Response(EquipmentIssueSerializer(issue).data, status=status.HTTP_201_CREATED)

    # ── Return ────────────────────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='return',
            permission_classes=[IsAnyAdmin])
    def return_equipment(self, request, pk=None):
        """
        Mark equipment as returned.
        Body: {"condition_at_return": "GOOD|FAIR|DAMAGED|LOST", "remarks": "..."}
        """
        item = self.get_object()
        issue = item.issues.filter(actual_return_date__isnull=True).first()
        if not issue:
            return Response({'detail': 'No outstanding issue found for this equipment.'},
                            status=status.HTTP_400_BAD_REQUEST)

        condition = request.data.get('condition_at_return', EquipmentIssue.CONDITION_GOOD)
        issue.actual_return_date  = timezone.now().date()
        issue.returned_to         = request.user
        issue.condition_at_return = condition
        issue.remarks             = (issue.remarks + '\n' + request.data.get('remarks', '')).strip()
        issue.save()

        new_status = (EquipmentItem.STATUS_MAINTENANCE
                      if condition == EquipmentIssue.CONDITION_DAMAGED
                      else EquipmentItem.STATUS_AVAILABLE)
        item.status         = new_status
        item.current_holder = None
        item.save(update_fields=['status', 'current_holder', 'updated_at'])

        return Response(EquipmentIssueSerializer(issue).data)

    # ── Send to maintenance ───────────────────────────────────────────────────

    @action(detail=True, methods=['post'], url_path='send-for-maintenance',
            permission_classes=[IsAnyAdmin])
    def send_for_maintenance(self, request, pk=None):
        """Mark equipment as Under Maintenance."""
        item = self.get_object()
        if item.status == EquipmentItem.STATUS_CONDEMNED:
            return Response({'detail': 'Condemned equipment cannot be sent for maintenance.'},
                            status=status.HTTP_400_BAD_REQUEST)
        item.status = EquipmentItem.STATUS_MAINTENANCE
        item.save(update_fields=['status', 'updated_at'])
        return Response({'status': item.status, 'status_display': item.get_status_display()})

    @action(detail=True, methods=['post'], url_path='mark-available',
            permission_classes=[IsAnyAdmin])
    def mark_available(self, request, pk=None):
        """Return equipment from maintenance to available."""
        item = self.get_object()
        item.status = EquipmentItem.STATUS_AVAILABLE
        item.save(update_fields=['status', 'updated_at'])
        return Response({'status': item.status, 'status_display': item.get_status_display()})


class EquipmentIssueViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Read-only issue/return log.
    Filter: ?equipment=<id>, ?issued_to=<user_id>, ?outstanding=true
    """
    serializer_class   = EquipmentIssueSerializer
    filter_backends    = [DjangoFilterBackend]
    filterset_fields   = ['equipment', 'issued_to', 'issued_for_project']
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return EquipmentIssue.objects.none()
        qs = EquipmentIssue.objects.select_related(
            'equipment__owned_by', 'issued_to', 'issued_by',
            'returned_to', 'issued_for_project',
        )
        qs = org_queryset_filter(self.request.user, qs, org_field='equipment__owned_by')
        # ?outstanding=true → only items not yet returned
        if self.request.query_params.get('outstanding') == 'true':
            qs = qs.filter(actual_return_date__isnull=True)
        return qs


class EquipmentMaintenanceViewSet(viewsets.ModelViewSet):
    serializer_class   = EquipmentMaintenanceSerializer
    filter_backends    = [DjangoFilterBackend]
    filterset_fields   = ['equipment', 'maintenance_type']
    permission_classes = [permissions.IsAuthenticated]

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsAnyAdmin()]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return EquipmentMaintenance.objects.none()
        qs = EquipmentMaintenance.objects.select_related(
            'equipment__owned_by', 'recorded_by',
        )
        return org_queryset_filter(self.request.user, qs, org_field='equipment__owned_by')

    def perform_create(self, serializer):
        maintenance = serializer.save(recorded_by=self.request.user)
        # Update calibration_due on the equipment when a calibration record is saved
        if maintenance.maintenance_type == EquipmentMaintenance.TYPE_CALIBRATION:
            equipment = maintenance.equipment
            if maintenance.next_due_date:
                equipment.calibration_due = maintenance.next_due_date
                equipment.save(update_fields=['calibration_due', 'updated_at'])
            if equipment.status == EquipmentItem.STATUS_MAINTENANCE:
                equipment.status = EquipmentItem.STATUS_AVAILABLE
                equipment.save(update_fields=['status', 'updated_at'])


# ─────────────────────────────────────────────────────────────────────────────
# Pre-Submission Checklist
# ─────────────────────────────────────────────────────────────────────────────

class SubmissionChecklistViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Read-only view of computed checklists.
    Use POST /api/field-ops/checklists/compute/ to trigger a fresh check.
    Use POST /api/field-ops/checklists/<id>/acknowledge/ to acknowledge warnings.
    """
    serializer_class   = SubmissionChecklistSerializer
    filter_backends    = [DjangoFilterBackend]
    filterset_fields   = ['survey_area']
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        if getattr(self, 'swagger_fake_view', False):
            return SubmissionChecklist.objects.none()
        qs = SubmissionChecklist.objects.select_related(
            'survey_area__project__organisation',
            'checked_by', 'acknowledged_by',
        )
        return org_queryset_filter(
            self.request.user, qs,
            org_field='survey_area__project__organisation',
        )

    @action(detail=False, methods=['post'], url_path='compute')
    def compute(self, request):
        """
        Run the checklist engine for a survey area and save the result.
        Body: {"survey_area_id": <int>}
        Returns the saved SubmissionChecklist record.
        """
        from apps.survey_projects.models import SurveyArea
        from .checklist_engine import run_checklist

        area_id = request.data.get('survey_area_id')
        if not area_id:
            return Response({'detail': 'survey_area_id is required.'},
                            status=status.HTTP_400_BAD_REQUEST)
        try:
            area = SurveyArea.objects.select_related('project__organisation').get(pk=area_id)
        except SurveyArea.DoesNotExist:
            return Response({'detail': 'SurveyArea not found.'}, status=status.HTTP_404_NOT_FOUND)

        result = run_checklist(area)

        checklist = SubmissionChecklist.objects.create(
            survey_area    = area,
            checked_by     = request.user,
            checks         = result['checks'],
            all_passed     = result['all_passed'],
            blocking_count = result['blocking_count'],
            warning_count  = result['warning_count'],
        )
        return Response(
            SubmissionChecklistSerializer(checklist, context={'request': request}).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'], url_path='acknowledge')
    def acknowledge(self, request, pk=None):
        """
        Surveyor acknowledges warnings (non-blocking issues) and consents to proceed.
        Only valid when blocking_count == 0 and there are unacknowledged warnings.
        """
        checklist = self.get_object()
        if checklist.blocking_count > 0:
            return Response(
                {'detail': f'Cannot acknowledge: {checklist.blocking_count} blocking error(s) must be fixed first.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if checklist.acknowledged_at:
            return Response({'detail': 'Already acknowledged.'}, status=status.HTTP_400_BAD_REQUEST)

        checklist.acknowledged_by = request.user
        checklist.acknowledged_at = timezone.now()
        checklist.save(update_fields=['acknowledged_by', 'acknowledged_at'])
        return Response(
            SubmissionChecklistSerializer(checklist, context={'request': request}).data
        )
