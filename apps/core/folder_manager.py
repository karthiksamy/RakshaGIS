"""
Manages the GIS data folder hierarchy that mirrors the organisation structure.

Host layout (all relative to settings.MEDIA_ROOT):
  gis_data/
  └── DGDE/
      └── {PDDE_CODE}/
          ├── {DEO_CODE}/
          │   ├── common_layers/{state,district,taluk,village,revenue}/
          │   ├── projects/{PROJECT_NUMBER}/{shapefiles,…}/
          │   ├── {CEO_CODE}/      ← CEO under DEO
          │   │   ├── common_layers/…
          │   │   └── projects/…
          │   └── {ADEO_CODE}/     ← ADEO under DEO
          │       ├── common_layers/…
          │       └── projects/…
          └── {CEO_CODE}/          ← CEO direct under PDDE
              ├── common_layers/…
              └── projects/…

get_org_path() walks the parent chain, so depth is automatic.
DEO, CEO, and ADEO offices all receive common_layers + projects/.
PDDE and DGDE receive only their own directory.
"""

import os
from django.conf import settings

# Sub-directories created under common_layers/ for every DEO
COMMON_LAYER_DIRS = ['state', 'district', 'taluk', 'village', 'revenue']

# Sub-directories created under every project folder
PROJECT_DIRS = [
    'shapefiles',
    'survey_reports',
    'inspection_reports',
    'revenue_extracts',
    'sketches',
    'photos',
    'exports',
]

# Maps Document.category to the project sub-directory
CATEGORY_TO_DIR = {
    'SURVEY_REPORT':     'survey_reports',
    'INSPECTION_REPORT': 'inspection_reports',
    'REVENUE_EXTRACT':   'revenue_extracts',
    'SKETCH':            'sketches',
    'PHOTO':             'photos',
    'OTHER':             'exports',
}


def _slug(text: str) -> str:
    """Return a filesystem-safe slug (uppercase, spaces → underscores)."""
    return text.strip().upper().replace(' ', '_').replace('/', '_')


def get_org_path(organisation) -> str:
    """
    Return the path segments for an organisation, from root to leaf.

    DGDE                  → "DGDE"
    PDDE under DGDE       → "DGDE/PDDE_CODE"
    DEO under PDDE/DGDE   → "DGDE/PDDE_CODE/DEO_CODE"
    """
    parts = []
    node = organisation
    while node is not None:
        parts.insert(0, _slug(node.code))
        node = node.parent
    return '/'.join(parts)


def get_project_rel_path(project) -> str:
    """
    Return the path of a project's folder relative to MEDIA_ROOT.
    e.g. "gis_data/DGDE/PDDE-SOUTH/DEO-CHN/projects/PRJ-001"
    """
    org_path = get_org_path(project.organisation)
    return f"gis_data/{org_path}/projects/{_slug(project.project_number)}"


def _makedirs(*parts):
    os.makedirs(os.path.join(settings.MEDIA_ROOT, *parts), exist_ok=True)


def create_org_folders(organisation):
    """
    Create the on-disk folder structure for an organisation.
    DEO, CEO, and ADEO offices get the full hierarchy (common_layers + projects/).
    PDDE and DGDE get only their own directory.
    """
    from apps.accounts.models import Organisation

    org_path = get_org_path(organisation)

    office_levels = (Organisation.DEO, Organisation.CEO, Organisation.ADEO)
    if organisation.level in office_levels:
        for layer in COMMON_LAYER_DIRS:
            _makedirs('gis_data', org_path, 'common_layers', layer)
        _makedirs('gis_data', org_path, 'projects')
    else:
        _makedirs('gis_data', org_path)


def create_project_folders(project):
    """Create the on-disk sub-directory tree for a survey project."""
    rel = get_project_rel_path(project)
    for folder in PROJECT_DIRS:
        _makedirs(rel, folder)


def document_upload_path(instance, filename):
    """
    Callable for Document.file upload_to.
    Resolves to:  gis_data/{ORG_PATH}/projects/{PROJECT_NUM}/{CATEGORY_DIR}/{filename}
    """
    rel = get_project_rel_path(instance.project)
    category_dir = CATEGORY_TO_DIR.get(instance.category, 'exports')
    return f"{rel}/{category_dir}/{filename}"
