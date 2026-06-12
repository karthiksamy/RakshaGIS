"""
Pre-Submission Checklist Engine
================================
Runs a battery of checks against a SurveyArea and returns a structured result
dict.  Called synchronously from the API view — all queries hit local PostgreSQL,
no internet required.

Each check returns:
  {"passed": bool, "severity": "ERROR"|"WARN", "message": str}

ERROR  → blocks submission (blocking_count > 0 prevents submit)
WARN   → advisory, surveyor can acknowledge and proceed
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from apps.survey_projects.models import SurveyArea


def _check(passed: bool, severity: str, ok_msg: str, fail_msg: str) -> dict:
    return {
        'passed':   passed,
        'severity': severity,
        'message':  ok_msg if passed else fail_msg,
    }


def run_checklist(survey_area: 'SurveyArea') -> dict:
    """
    Execute all checks and return a summary dict:
      {
        "checks": {<name>: {passed, severity, message}, ...},
        "all_passed": bool,
        "blocking_count": int,
        "warning_count": int,
      }
    """
    from apps.survey_projects.models import GISFeature, AttributeTemplate
    from apps.documents.models import Document

    checks: dict[str, dict] = {}

    # ── 1. Survey area has a name / title ────────────────────────────────────
    checks['area_name'] = _check(
        passed=bool(survey_area.name and survey_area.name.strip()),
        severity='ERROR',
        ok_msg='Survey area has a name.',
        fail_msg='Survey area name is empty.',
    )

    # ── 2. At least one GIS feature exists ──────────────────────────────────
    feature_qs = GISFeature.objects.filter(survey_area=survey_area, is_deleted=False)
    feature_count = feature_qs.count()
    checks['has_features'] = _check(
        passed=feature_count > 0,
        severity='ERROR',
        ok_msg=f'{feature_count} GIS feature(s) present.',
        fail_msg='No GIS features recorded for this survey area.',
    )

    # ── 3. All features have valid (non-null, non-empty) geometry ───────────
    null_geom_count = feature_qs.filter(geometry__isnull=True).count()
    checks['features_have_geometry'] = _check(
        passed=null_geom_count == 0,
        severity='ERROR',
        ok_msg='All features have geometry.',
        fail_msg=f'{null_geom_count} feature(s) are missing geometry.',
    )

    # ── 4. Mandatory attribute fields filled (via AttributeTemplate) ─────────
    missing_attrs: list[str] = []
    templates = AttributeTemplate.objects.filter(
        organisation=survey_area.project.organisation
    )
    if templates.exists():
        for feat in feature_qs.only('attributes', 'layer_name')[:500]:
            for tpl in templates:
                if feat.layer_name != tpl.layer_name:
                    continue
                for field in tpl.fields:
                    if field.get('required'):
                        key = field.get('name', '')
                        if not feat.attributes.get(key):
                            missing_attrs.append(
                                f'Feature #{feat.pk}: "{key}" is empty')
    checks['mandatory_attributes'] = _check(
        passed=len(missing_attrs) == 0,
        severity='ERROR',
        ok_msg='All mandatory attribute fields are filled.',
        fail_msg=f'{len(missing_attrs)} mandatory field(s) empty: '
                 + '; '.join(missing_attrs[:5])
                 + ('…' if len(missing_attrs) > 5 else ''),
    )

    # ── 5. At least one document attached to the project ────────────────────
    doc_count = Document.objects.filter(project=survey_area.project).count()
    checks['has_documents'] = _check(
        passed=doc_count > 0,
        severity='WARN',
        ok_msg=f'{doc_count} document(s) attached to the project.',
        fail_msg='No documents attached. At least one survey report is recommended.',
    )

    # ── 6. Survey area has an assigned surveyor ──────────────────────────────
    checks['has_assignee'] = _check(
        passed=survey_area.assigned_to_id is not None,
        severity='WARN',
        ok_msg='Survey area has an assigned surveyor.',
        fail_msg='No surveyor assigned to this survey area.',
    )

    # ── 7. Survey area due date is not already past ─────────────────────────
    from django.utils import timezone
    from apps.survey_projects.models import SurveyProject
    project: SurveyProject = survey_area.project
    if project.due_date:
        overdue = project.due_date < timezone.now().date()
        checks['due_date'] = _check(
            passed=not overdue,
            severity='WARN',
            ok_msg=f'Due date {project.due_date} has not passed.',
            fail_msg=f'Project due date {project.due_date} has passed.',
        )

    # ── 8. No topology errors (self-intersecting polygons) ───────────────────
    from django.db import connection
    try:
        with connection.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM survey_projects_gisfeature
                WHERE survey_area_id = %s
                  AND is_deleted = FALSE
                  AND geometry IS NOT NULL
                  AND NOT ST_IsValid(geometry)
            """, [survey_area.id])
            invalid_geom_count = cur.fetchone()[0]
    except Exception:
        invalid_geom_count = 0

    checks['topology'] = _check(
        passed=invalid_geom_count == 0,
        severity='ERROR',
        ok_msg='All feature geometries are topologically valid.',
        fail_msg=f'{invalid_geom_count} feature(s) have invalid geometry (self-intersections etc.).',
    )

    # ── 9. Field diary (DPR) submitted for this area ─────────────────────────
    try:
        from apps.field_ops.models import FieldDiaryEntry
        dpr_count = FieldDiaryEntry.objects.filter(
            survey_area=survey_area, submitted_at__isnull=False
        ).count()
        checks['field_diary_submitted'] = _check(
            passed=dpr_count > 0,
            severity='WARN',
            ok_msg=f'{dpr_count} submitted DPR entry(ies) recorded.',
            fail_msg='No submitted Field Diary (DPR) entries found for this survey area.',
        )
    except Exception:
        pass

    # ── Aggregate ─────────────────────────────────────────────────────────────
    blocking = sum(
        1 for v in checks.values()
        if not v['passed'] and v['severity'] == 'ERROR'
    )
    warnings = sum(
        1 for v in checks.values()
        if not v['passed'] and v['severity'] == 'WARN'
    )

    return {
        'checks':         checks,
        'all_passed':     blocking == 0 and warnings == 0,
        'blocking_count': blocking,
        'warning_count':  warnings,
    }
