from rest_framework import viewsets, permissions
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from .models import Organisation, User
from .permissions import (
    IsSuperAdmin, CanManageUsers, OrgScopedAccess,
    org_queryset_filter, get_assignable_roles,
)
from .serializers import OrganisationSerializer, UserSerializer, UserProfileSerializer


class OrganisationViewSet(viewsets.ModelViewSet):
    queryset = Organisation.objects.select_related('parent').order_by('level', 'name')
    serializer_class = OrganisationSerializer

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsSuperAdmin()]

    def get_queryset(self):
        return org_queryset_filter(self.request.user, super().get_queryset())


class UserViewSet(viewsets.ModelViewSet):
    serializer_class = UserSerializer

    def get_permissions(self):
        if self.action == 'me':
            return [permissions.IsAuthenticated()]
        if self.action in ['list', 'retrieve']:
            return [CanManageUsers()]
        if self.action in ['update', 'partial_update', 'destroy']:
            return [CanManageUsers(), OrgScopedAccess()]
        return [CanManageUsers()]  # create

    def get_queryset(self):
        user = self.request.user
        qs = User.objects.select_related('organisation').order_by('username')
        if user.role == User.SUPERADMIN:
            return qs
        if user.role in (User.DEO_ADMIN, User.CEO_ADMIN, User.ADEO_ADMIN):
            # Admins see non-admin users within their own org only
            return qs.filter(organisation=user.organisation).exclude(
                role__in=User.ADMIN_ROLES
            )
        return qs.filter(pk=user.pk)

    def perform_create(self, serializer):
        user = self.request.user
        if user.role == User.SUPERADMIN:
            serializer.save()
            return

        if user.role in (User.DEO_ADMIN, User.CEO_ADMIN, User.ADEO_ADMIN):
            allowed = get_assignable_roles(user.role)
            role = serializer.validated_data.get('role', User.SDO)
            if role not in allowed:
                raise PermissionDenied(
                    f"{user.get_role_display()} can only create: "
                    + ", ".join(sorted(allowed))
                )
            serializer.save(organisation=user.organisation)
            return

        raise PermissionDenied("You do not have permission to create users.")

    @action(detail=False, methods=['get'], permission_classes=[permissions.IsAuthenticated])
    def me(self, request):
        serializer = UserProfileSerializer(request.user)
        return Response(serializer.data)
