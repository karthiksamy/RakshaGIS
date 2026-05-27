from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import (
    SurveyProjectViewSet, SurveyAreaViewSet, GISFeatureViewSet, DefenceParcelViewSet,
    AttributeTemplateViewSet, ShapefileImportViewSet,
    ProjectLayerFolderViewSet, ProjectShareViewSet, GeoTiffLayerViewSet,
    BufferAnalysisView, TopologyCheckView,
    FeatureAttachmentViewSet, CSVImportView, EncroachmentView,
    FeatureMergeView, FeatureSplitView, ProjectMilestoneViewSet,
    QGISUploadLogViewSet, TemporaryLayerViewSet,
)

router = DefaultRouter()
router.register('', SurveyProjectViewSet, basename='survey-project')
router.register('survey-areas', SurveyAreaViewSet, basename='survey-area')
router.register('features', GISFeatureViewSet, basename='gis-feature')
router.register('parcels', DefenceParcelViewSet, basename='defence-parcel')
router.register('attribute-templates', AttributeTemplateViewSet, basename='attribute-template')
router.register('shapefile-imports', ShapefileImportViewSet, basename='shapefile-import')
router.register('folders', ProjectLayerFolderViewSet, basename='project-folder')
router.register('shares', ProjectShareViewSet, basename='project-share')
router.register('geotiffs', GeoTiffLayerViewSet, basename='geotiff-layer')
router.register('attachments', FeatureAttachmentViewSet, basename='feature-attachment')
router.register('milestones', ProjectMilestoneViewSet, basename='project-milestone')
router.register('qgis-uploads', QGISUploadLogViewSet, basename='qgis-upload-log')
router.register('temp-layers', TemporaryLayerViewSet, basename='temp-layer')

urlpatterns = router.urls + [
    path('buffer/', BufferAnalysisView.as_view(), name='buffer-analysis'),
    path('topology/', TopologyCheckView.as_view(), name='topology-check'),
    path('<int:pk>/import-csv/', CSVImportView.as_view(), name='csv-import'),
    path('<int:pk>/encroachments/', EncroachmentView.as_view(), name='encroachments'),
    path('features/merge/', FeatureMergeView.as_view(), name='feature-merge'),
    path('features/<int:pk>/split/', FeatureSplitView.as_view(), name='feature-split'),
]
