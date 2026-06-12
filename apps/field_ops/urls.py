from rest_framework.routers import DefaultRouter

from .views import (
    EncroachmentRecordViewSet, EncroachmentAttachmentViewSet,
    FieldDiaryEntryViewSet,
    EquipmentCategoryViewSet, EquipmentItemViewSet,
    EquipmentIssueViewSet, EquipmentMaintenanceViewSet,
    SubmissionChecklistViewSet,
)

router = DefaultRouter()
router.register('encroachments',           EncroachmentRecordViewSet,     basename='encroachment')
router.register('encroachment-attachments', EncroachmentAttachmentViewSet, basename='encroachment-attachment')
router.register('diary',                   FieldDiaryEntryViewSet,        basename='field-diary')
router.register('equipment-categories',    EquipmentCategoryViewSet,      basename='equipment-category')
router.register('equipment',               EquipmentItemViewSet,          basename='equipment')
router.register('equipment-issues',        EquipmentIssueViewSet,         basename='equipment-issue')
router.register('equipment-maintenance',   EquipmentMaintenanceViewSet,   basename='equipment-maintenance')
router.register('checklists',              SubmissionChecklistViewSet,    basename='submission-checklist')

urlpatterns = router.urls
