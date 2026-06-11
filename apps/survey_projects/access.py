"""Centralised org-level data-isolation helpers.

Visibility rules across the DGDE → PDDE → DEO → CEO/ADEO office tree:

• A project and its survey areas (subfolders) belong to the office that
  created them and are visible ONLY there, unless explicitly permitted
  (ProjectShare grant, approved SurveyAreaAccessRequest, or a subordinate
  office's deo_visible opt-in toward its parent DEO).

• DGDE/PDDE office users may create and manage their OWN org's projects,
  but never see subordinate offices' projects. Subordinate data reaches
  them only as PUBLISHED, map-enabled survey areas through the Map Viewer.

• AI assistant retrieval scope: DGDE → all organisational data;
  PDDE → its command subtree; DEO/CEO/ADEO → same as the projects UI
  (own org + explicit grants).
"""
from apps.accounts.models import Organisation


def hq_level(user):
    """Return 'DGDE' or 'PDDE' for non-superadmin users at those office levels.

    These users are Map-Viewer-only with respect to subordinate offices.
    Returns None for superadmins and all field-office users.
    """
    if user.is_superadmin:
        return None
    level = getattr(getattr(user, 'organisation', None), 'level', None)
    return level if level in (Organisation.DGDE, Organisation.PDDE) else None


def published_map_filter(user, qs, org_field='project__organisation'):
    """Scope a published-maps queryset for an HQ (DGDE/PDDE) user.

    DGDE sees every office's published maps; PDDE only its own command
    subtree (children DEOs + their CEO/ADEO offices).
    """
    if hq_level(user) == Organisation.PDDE:
        return qs.filter(**{f'{org_field}_id__in': user.organisation.get_subtree_ids()})
    return qs


def permitted_extra_project_ids(user) -> list:
    """Project IDs visible beyond the user's own org via explicit grants only."""
    from apps.accounts.permissions import (
        get_shared_project_ids, get_approved_area_ids, deo_subordinate_org_ids,
    )
    from .models import SurveyArea, GISFeature, GeoTiffLayer

    shared_ids = get_shared_project_ids(user)
    approved_project_ids = list(
        SurveyArea.objects.filter(id__in=get_approved_area_ids(user))
        .values_list('project_id', flat=True)
    )
    deo_sub_ids = deo_subordinate_org_ids(user)
    deo_project_ids: list = []
    if deo_sub_ids:
        deo_project_ids = list(set(
            list(GISFeature.objects.filter(
                project__organisation_id__in=deo_sub_ids,
                deo_visible=True, is_deleted=False,
            ).values_list('project_id', flat=True))
            + list(GeoTiffLayer.objects.filter(
                project__organisation_id__in=deo_sub_ids, deo_visible=True,
            ).values_list('project_id', flat=True))
        ))
    return list(set(shared_ids + approved_project_ids + deo_project_ids))


def ai_project_ids(user):
    """Projects the AI assistant may retrieve data from. None = unrestricted.

    DGDE (and superadmin) → all data; PDDE → subtree offices;
    DEO/CEO/ADEO → own org + explicitly permitted projects.
    """
    from .models import SurveyProject

    if user.is_superadmin:
        return None
    org = getattr(user, 'organisation', None)
    if org is None:
        return []
    if org.level == Organisation.DGDE:
        return None
    if org.level == Organisation.PDDE:
        return list(SurveyProject.objects.filter(
            organisation_id__in=org.get_subtree_ids()
        ).values_list('id', flat=True))
    own_ids = list(SurveyProject.objects.filter(organisation=org)
                   .values_list('id', flat=True))
    return list(set(own_ids + permitted_extra_project_ids(user)))


def ai_can_access_project(user, project_id) -> bool:
    """True if the AI assistant may use this project as retrieval context."""
    scope = ai_project_ids(user)
    if scope is None:
        return True
    try:
        return int(project_id) in set(scope)
    except (TypeError, ValueError):
        return False
