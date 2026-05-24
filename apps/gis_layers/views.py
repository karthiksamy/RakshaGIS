from rest_framework import viewsets, permissions
from rest_framework.permissions import SAFE_METHODS
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter

from apps.accounts.permissions import IsSuperAdmin
from .models import State, District, Taluk, Village, RevenueMap
from .serializers import (
    StateSerializer, DistrictSerializer, TalukSerializer,
    VillageSerializer, RevenueMapSerializer,
)


class _GISLayerPermission(permissions.BasePermission):
    """All authenticated users can read GIS layers; only SUPERADMIN can write."""

    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_superadmin


class StateViewSet(viewsets.ModelViewSet):
    queryset = State.objects.all().order_by('name')
    serializer_class = StateSerializer
    permission_classes = [_GISLayerPermission]
    filter_backends = [SearchFilter]
    search_fields = ['name', 'code']


class DistrictViewSet(viewsets.ModelViewSet):
    queryset = District.objects.select_related('state').order_by('name')
    serializer_class = DistrictSerializer
    permission_classes = [_GISLayerPermission]
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['state']
    search_fields = ['name', 'code']


class TalukViewSet(viewsets.ModelViewSet):
    queryset = Taluk.objects.select_related('district__state').order_by('name')
    serializer_class = TalukSerializer
    permission_classes = [_GISLayerPermission]
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['district', 'district__state']
    search_fields = ['name', 'code']


class VillageViewSet(viewsets.ModelViewSet):
    queryset = Village.objects.select_related('taluk__district__state').order_by('name')
    serializer_class = VillageSerializer
    permission_classes = [_GISLayerPermission]
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['taluk', 'taluk__district', 'taluk__district__state']
    search_fields = ['name', 'code']


class RevenueMapViewSet(viewsets.ModelViewSet):
    queryset = RevenueMap.objects.select_related('village__taluk__district__state').order_by('survey_number')
    serializer_class = RevenueMapSerializer
    permission_classes = [_GISLayerPermission]
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['village', 'village__taluk', 'village__taluk__district', 'classification']
    search_fields = ['survey_number', 'notes']
