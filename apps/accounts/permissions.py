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
        from apps.survey_projects.models import SurveyProject, ProjectLayerFolder, GISFeature, SurveyArea
        if request.method in SAFE_METHODS:
            return True
        user = request.user
        if user.role == User.SUPERADMIN:
            return True
        if not user.role in (User.SDO, User.SURVEYOR):
            return False
        # ProjectLayerFolder: org is on the related project
        if isinstance(obj, ProjectLayerFolder):
            return obj.project.organisation_id == user.organisation_id
        # GISFeature: org is via project
        if isinstance(obj, GISFeature):
            return obj.project.organisation_id == user.organisation_id
        # SurveyArea: org is via project (status guard is in perform_destroy/perform_update)
        if isinstance(obj, SurveyArea):
            return obj.project.organisation_id == user.organisation_id
        # SurveyProject and other org-direct models
        editable_statuses = (SurveyProject.DRAFT, SurveyProject.RETURNED)
        org_id = getattr(obj, 'organisation_id', None)
        status  = getattr(obj, 'status', None)
        if org_id is None or status is None:
            return False
        return org_id == user.organisation_id and status in editable_statuses


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


def get_shared_project_ids(user) -> list:
    """Return IDs of projects shared to the user's org via ProjectShare grants."""
    from apps.survey_projects.models import ProjectShare
    return list(
        ProjectShare.objects.filter(granted_to=user.organisation)
        .values_list('project_id', flat=True)
    )


def get_approved_area_ids(user) -> list:
    """Return IDs of survey areas this user's org has approved cross-org access to."""
    from apps.survey_projects.models import SurveyAreaAccessRequest
    return list(
        SurveyAreaAccessRequest.objects.filter(
            requesting_org=user.organisation,
            status=SurveyAreaAccessRequest.APPROVED,
        ).values_list('survey_area_id', flat=True)
    )
