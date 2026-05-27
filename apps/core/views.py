from rest_framework import viewsets, permissions
from rest_framework.exceptions import PermissionDenied
from rest_framework.views import APIView
from rest_framework.response import Response

from apps.accounts.permissions import IsSuperAdmin
from .models import BasemapConfig, BrandingConfig
from .serializers import BasemapConfigSerializer, BrandingConfigSerializer


class BrandingConfigView(APIView):
    """GET: public (no auth). PATCH: superadmin only."""

    def get_permissions(self):
        if self.request.method == 'GET':
            return [permissions.AllowAny()]
        return [IsSuperAdmin()]

    def get(self, request):
        obj = BrandingConfig.get_solo()
        return Response(BrandingConfigSerializer(obj).data)

    def patch(self, request):
        obj = BrandingConfig.get_solo()
        ser = BrandingConfigSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)


class BasemapConfigViewSet(viewsets.ModelViewSet):
    serializer_class = BasemapConfigSerializer

    def get_queryset(self):
        qs = BasemapConfig.objects.select_related('created_by')
        # Non-superadmin users only see active basemaps
        if not (self.request.user.is_authenticated and self.request.user.is_superadmin):
            qs = qs.filter(is_active=True)
        return qs

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsSuperAdmin()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance):
        if instance.is_system:
            raise PermissionDenied("System basemap configurations cannot be deleted.")
        instance.delete()
