from celery import shared_task
import logging

logger = logging.getLogger(__name__)


@shared_task(name='apps.revenue_connectors.tasks.test_connector')
def test_connector_task(connector_id: int) -> dict:
    """Run connectivity test for a single connector and persist the result."""
    from django.utils import timezone
    from .models import RevenuePortalConnector
    from .connectors import test_connector

    try:
        conn = RevenuePortalConnector.objects.get(pk=connector_id)
    except RevenuePortalConnector.DoesNotExist:
        return {'error': f'Connector {connector_id} not found'}

    ok, msg = test_connector(conn)
    conn.test_status    = RevenuePortalConnector.STATUS_OK if ok else RevenuePortalConnector.STATUS_ERROR
    conn.test_message   = msg
    conn.last_tested_at = timezone.now()
    conn.save(update_fields=['test_status', 'test_message', 'last_tested_at'])

    logger.info('Connector %s test: %s — %s', connector_id, conn.test_status, msg)
    return {'connector_id': connector_id, 'status': conn.test_status, 'message': msg}


@shared_task(name='apps.revenue_connectors.tasks.cross_reference_parcel')
def cross_reference_parcel_task(parcel_id: int,
                                 connector_ids: list[int] | None = None) -> dict:
    """Cross-reference a single DefenceParcel against one or more revenue connectors."""
    from apps.survey_projects.models import DefenceParcel
    from .models import RevenuePortalConnector
    from .connectors import cross_reference_parcel

    try:
        parcel = DefenceParcel.objects.get(pk=parcel_id)
    except DefenceParcel.DoesNotExist:
        return {'error': f'DefenceParcel {parcel_id} not found'}

    connectors = None
    if connector_ids:
        connectors = list(RevenuePortalConnector.objects.filter(
            pk__in=connector_ids, is_active=True))

    result = cross_reference_parcel(parcel, connectors)
    logger.info('cross_reference_parcel parcel=%s result=%s', parcel_id, result)
    return result


@shared_task(name='apps.revenue_connectors.tasks.cross_reference_all_parcels')
def cross_reference_all_parcels_task(organisation_id: int | None = None) -> dict:
    """
    Bulk cross-reference: run all active connectors against all parcels in an
    organisation (or across all organisations if organisation_id is None).
    Queues one sub-task per parcel so the work is distributed across workers.
    """
    from apps.survey_projects.models import DefenceParcel

    qs = DefenceParcel.objects.filter(geometry__isnull=False)
    if organisation_id:
        qs = qs.filter(organisation_id=organisation_id)

    ids    = list(qs.values_list('id', flat=True))
    queued = 0
    for pid in ids:
        cross_reference_parcel_task.delay(pid)
        queued += 1

    logger.info('cross_reference_all_parcels queued=%d org=%s', queued, organisation_id)
    return {'parcels_queued': queued, 'organisation_id': organisation_id}
