from rest_framework import viewsets, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter, OrderingFilter

from apps.accounts.permissions import CanEditProject, IsSuperAdmin, org_queryset_filter
from .models import SurveyProject, GISFeature, DefenceParcel, AttributeTemplate, ShapefileImport
from .serializers import (
    SurveyProjectSerializer, GISFeatureSerializer, DefenceParcelSerializer,
    AttributeTemplateSerializer, ShapefileImportSerializer,
)


class SurveyProjectViewSet(viewsets.ModelViewSet):
    serializer_class = SurveyProjectSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ['status', 'survey_type', 'priority', 'organisation', 'state', 'district', 'taluk', 'village']
    search_fields = ['name', 'project_number', 'description']
    ordering_fields = ['created_at', 'updated_at', 'name', 'priority']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            SurveyProject.objects.select_related(
                'organisation', 'created_by', 'state', 'district', 'taluk', 'village'
            )
        )

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [CanEditProject()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(
            created_by=self.request.user,
            organisation=self.request.user.organisation,
        )


class GISFeatureViewSet(viewsets.ModelViewSet):
    serializer_class = GISFeatureSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['project', 'layer_name', 'geometry_type', 'is_deleted']
    search_fields = ['layer_name', 'feature_id']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            GISFeature.objects.select_related('project__organisation', 'created_by'),
            org_field='project__organisation'
        ).filter(is_deleted=False)

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [CanEditProject()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance):
        instance.is_deleted = True
        instance.save(update_fields=['is_deleted'])


class AttributeTemplateViewSet(viewsets.ModelViewSet):
    """
    Org-scoped attribute schema definitions for GIS layers.
    SDO/SURVEYOR and admins can manage templates for their own org.
    """
    serializer_class = AttributeTemplateSerializer

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            AttributeTemplate.objects.select_related('organisation', 'created_by'),
        )

    def get_permissions(self):
        return [CanEditProject()]  # same gate: SDO/SURVEYOR + SUPERADMIN

    def perform_create(self, serializer):
        serializer.save(
            organisation=self.request.user.organisation,
            created_by=self.request.user,
        )


class ShapefileImportViewSet(viewsets.ModelViewSet):
    """Upload a .zip shapefile and trigger async import into GISFeature rows."""
    serializer_class = ShapefileImportSerializer
    http_method_names = ['get', 'post', 'head', 'options']  # no update/delete

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            ShapefileImport.objects.select_related(
                'project__organisation', 'attribute_template', 'created_by'
            ),
        )

    def get_permissions(self):
        return [CanEditProject()]

    def perform_create(self, serializer):
        from .tasks import import_shapefile
        job = serializer.save(
            created_by=self.request.user,
            status=ShapefileImport.PENDING,
        )
        import_shapefile.delay(job.id)


class DefenceParcelViewSet(viewsets.ModelViewSet):
    serializer_class = DefenceParcelSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ['category', 'classification', 'organisation', 'state', 'district', 'taluk', 'village']
    search_fields = ['parcel_id', 'name', 'encumbrance_notes']
    ordering_fields = ['parcel_id', 'name', 'area_hectares']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            DefenceParcel.objects.select_related(
                'organisation', 'state', 'district', 'taluk', 'village', 'survey_project'
            ).prefetch_related('revenue_maps')
        )

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [IsSuperAdmin()]
        return [permissions.IsAuthenticated()]
