from rest_framework.permissions import BasePermission, SAFE_METHODS

from .models import User


class IsSuperAdmin(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.role == User.SUPERADMIN


class CanManageUsers(BasePermission):
    """
    SUPERADMIN can manage any user.
    DEO_ADMIN / CEO_ADMIN / ADEO_ADMIN can manage non-admin users within their own org.
    """

    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.can_manage_users

    def has_object_permission(self, request, view, obj):
        user = request.user
        if user.role == User.SUPERADMIN:
            return True

        # All non-superadmin admins: target must be in same org and not an admin/superadmin
        if user.role in (User.DEO_ADMIN, User.CEO_ADMIN, User.ADEO_ADMIN):
            return (
                obj.organisation_id == user.organisation_id
                and obj.role not in User.ADMIN_ROLES
            )
        return False


# Roles each admin level is permitted to create / assign
_ADMIN_ASSIGNABLE_ROLES = {
    User.DEO_ADMIN:  {User.SDO,      User.CHECKER, User.APPROVER, User.VIEWER},
    User.CEO_ADMIN:  {User.SURVEYOR, User.CHECKER, User.APPROVER, User.VIEWER},
    User.ADEO_ADMIN: {User.SURVEYOR, User.CHECKER, User.APPROVER, User.VIEWER},
}


def get_assignable_roles(admin_role: str) -> set:
    """Return the set of roles an admin may assign to new users."""
    return _ADMIN_ASSIGNABLE_ROLES.get(admin_role, set())


class CanEditProject(BasePermission):
    """SDO/Surveyor (and SUPERADMIN) may create/edit GIS projects when DRAFT or RETURNED."""

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return request.user.is_authenticated
        return request.user.is_authenticated and request.user.can_forward

    def has_object_permission(self, request, view, obj):
        from apps.survey_projects.models import SurveyProject
        if request.method in SAFE_METHODS:
            return True
        user = request.user
        if user.role == User.SUPERADMIN:
            return True
        editable_statuses = (SurveyProject.DRAFT, SurveyProject.RETURNED)
        return (
            user.role in (User.SDO, User.SURVEYOR)
            and obj.organisation_id == user.organisation_id
            and obj.status in editable_statuses
        )


class CanCheck(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.can_check


class CanApprove(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.can_approve


class CanPublish(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.can_publish


class OrgScopedAccess(BasePermission):
    """
    Object-level: enforce org visibility rules.
      SUPERADMIN   → everything
      PDDE_VIEWER  → own PDDE org + full subtree (DEO + CEO + ADEO under it)
      All others   → own org only
    """

    def has_object_permission(self, request, view, obj):
        user = request.user
        if user.role == User.SUPERADMIN:
            return True

        org = getattr(obj, 'organisation', None)
        if org is None:
            return False

        if user.role == User.PDDE_VIEWER:
            return org.id in user.organisation.get_subtree_ids()

        return org == user.organisation


def org_queryset_filter(user, qs, org_field='organisation'):
    """
    Reusable helper: filter a queryset to records visible to the given user.

    - SUPERADMIN        → no filter (sees all)
    - PDDE_VIEWER       → own PDDE + full subtree (2-hop: children + grandchildren)
    - All other roles   → own org only
    """
    if user.role == User.SUPERADMIN:
        return qs
    if user.role == User.PDDE_VIEWER:
        return qs.filter(**{f'{org_field}_id__in': user.organisation.get_subtree_ids()})
    return qs.filter(**{org_field: user.organisation})
