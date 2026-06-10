from celery import shared_task
from django.db import connection
from django.utils import timezone
from datetime import timedelta
import logging

logger = logging.getLogger(__name__)


def _scan_project_overlaps(project_id, org_id):
    """Run PostGIS overlap check for a project against all other published orgs."""
    sql = """
        SELECT DISTINCT ON (sf.id, tf.id)
            sf.id                 AS source_feature_id,
            sf.layer_name         AS source_layer,
            tf.id                 AS target_feature_id,
            tf.layer_name         AS target_layer,
            tp.project_number     AS target_project,
            tp.id                 AS target_project_id,
            o.name                AS target_org,
            ROUND(
                ST_Area(ST_Transform(
                    ST_Intersection(sf.geometry, tf.geometry), 32643
                ))::numeric, 2
            )                     AS overlap_sqm
        FROM survey_projects_gisfeature sf
        JOIN survey_projects_gisfeature tf
            ON ST_Intersects(sf.geometry, tf.geometry)
           AND sf.id != tf.id
        JOIN survey_projects_surveyproject tp ON tf.project_id = tp.id
        JOIN accounts_organisation o ON tp.organisation_id = o.id
        WHERE sf.project_id      = %s
          AND sf.geometry_type   = 'POLYGON'
          AND sf.is_deleted      = false
          AND tf.geometry_type   = 'POLYGON'
          AND tf.is_deleted      = false
          AND tp.organisation_id != %s
          AND EXISTS (
              SELECT 1 FROM survey_projects_surveyarea sa
              WHERE sa.project_id = tp.id AND sa.status = 'PUBLISHED'
          )
        LIMIT 100
    """
    with connection.cursor() as cur:
        cur.execute(sql, [project_id, org_id])
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


@shared_task(name='apps.workflow.tasks.run_encroachment_scan')
def run_encroachment_scan():
    """
    Scan all published projects for spatial overlaps with other organisations.
    Creates DisputeReport records and sends notifications for new encroachments.
    Runs twice daily via Celery beat.
    """
    from apps.survey_projects.models import SurveyProject, SurveyArea
    from apps.workflow.models import DisputeReport, Notification
    from apps.accounts.models import User

    # All projects that have at least one published area
    published_project_ids = list(
        SurveyArea.objects.filter(status='PUBLISHED')
        .values_list('project_id', flat=True)
        .distinct()
    )

    new_count = 0
    checked = 0

    for project in SurveyProject.objects.filter(
        id__in=published_project_ids
    ).select_related('organisation'):
        # Representative area (use first published one)
        area = SurveyArea.objects.filter(
            project=project, status='PUBLISHED'
        ).first()
        if not area:
            continue

        # Skip if we already have a fresh unacknowledged report (< 12 hours old)
        already_fresh = DisputeReport.objects.filter(
            survey_area__project=project,
            status=DisputeReport.HAS_DISPUTES,
            acknowledged=False,
            checked_at__gte=timezone.now() - timedelta(hours=12),
        ).exists()
        if already_fresh:
            continue

        checked += 1
        try:
            disputes = _scan_project_overlaps(project.id, project.organisation_id)
        except Exception as exc:
            logger.warning('Encroachment scan failed for project %s: %s', project.id, exc)
            continue

        if not disputes:
            continue

        report = DisputeReport.objects.create(
            survey_area=area,
            status=DisputeReport.HAS_DISPUTES,
            disputes=disputes,
            acknowledged=False,
        )
        new_count += len(disputes)
        logger.info(
            'Encroachment: project %s has %d overlaps — DisputeReport %d created',
            project.project_number, len(disputes), report.id,
        )

        # Notify SDO / project-level officers of this organisation
        overlapping_orgs = list({d.get('target_org', '') for d in disputes})
        msg = (
            f"Spatial overlap detected for project {project.project_number} "
            f"({area.name}) with {', '.join(overlapping_orgs)}. "
            f"{len(disputes)} overlapping feature(s) found."
        )
        # Notify all users of the project's organisation who can manage projects
        recipients = User.objects.filter(
            organisation=project.organisation,
            is_active=True,
            role__in=['SDO', 'APPROVER', 'SUPERADMIN'],
        )
        notifications = [
            Notification(
                recipient=u,
                title='Encroachment Alert',
                message=msg,
                notification_type=Notification.SYSTEM,
                project=project,
            )
            for u in recipients
        ]
        if notifications:
            Notification.objects.bulk_create(notifications, ignore_conflicts=True)

    logger.info(
        'Encroachment scan done: checked %d projects, %d new overlap(s)',
        checked, new_count,
    )
    return {'checked': checked, 'new_encroachments': new_count}
