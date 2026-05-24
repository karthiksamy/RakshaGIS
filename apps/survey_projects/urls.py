from rest_framework.routers import DefaultRouter
from .views import (
    SurveyProjectViewSet, GISFeatureViewSet, DefenceParcelViewSet,
    AttributeTemplateViewSet, ShapefileImportViewSet,
)

router = DefaultRouter()
router.register('', SurveyProjectViewSet, basename='survey-project')
router.register('features', GISFeatureViewSet, basename='gis-feature')
router.register('parcels', DefenceParcelViewSet, basename='defence-parcel')
router.register('attribute-templates', AttributeTemplateViewSet, basename='attribute-template')
router.register('shapefile-imports', ShapefileImportViewSet, basename='shapefile-import')

urlpatterns = router.urls
