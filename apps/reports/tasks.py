from celery import shared_task
from django.core.mail import send_mail
from django.utils import timezone
from django.conf import settings


@shared_task(name='apps.reports.tasks.send_scheduled_reports')
def send_scheduled_reports():
    """Run daily. Sends any ReportSchedule whose next_run is past due."""
    from .models import ReportSchedule
    from apps.survey_projects.models import SurveyProject
    from apps.accounts.models import User
    from django.db.models import Count, Q
    import datetime

    now = timezone.now()
    due = ReportSchedule.objects.filter(is_active=True).filter(
        Q(next_run__isnull=True) | Q(next_run__lte=now)
    ).select_related('organisation')

    for schedule in due:
        try:
            body = _build_report_body(schedule)
            recipients = [e.strip() for e in schedule.recipients.split(',') if e.strip()]
            if recipients:
                send_mail(
                    subject=f'RakshaGIS Report: {schedule.name}',
                    message=body,
                    from_email=settings.DEFAULT_FROM_EMAIL,
                    recipient_list=recipients,
                    fail_silently=True,
                )
            schedule.last_sent = now
            schedule.next_run = _calc_next_run(schedule.frequency, now)
            schedule.save(update_fields=['last_sent', 'next_run'])
        except Exception:
            pass


def _build_report_body(schedule):
    from apps.survey_projects.models import SurveyProject
    from django.db.models import Count, Q

    lines = [f'RakshaGIS Scheduled Report: {schedule.name}',
             f'Report Type : {schedule.get_report_type_display()}',
             f'Organisation: {schedule.organisation.name}',
             '']

    projects = SurveyProject.objects.filter(organisation=schedule.organisation)
    stats = projects.aggregate(
        total=Count('id'),
        draft=Count('id', filter=Q(status='DRAFT')),
        submitted=Count('id', filter=Q(status='SUBMITTED')),
        under_review=Count('id', filter=Q(status='UNDER_REVIEW')),
        approved=Count('id', filter=Q(status='APPROVED')),
        published=Count('id', filter=Q(status='PUBLISHED')),
    )
    lines += [
        'Project Status Summary',
        f"  Total       : {stats['total']}",
        f"  Draft       : {stats['draft']}",
        f"  Submitted   : {stats['submitted']}",
        f"  Under Review: {stats['under_review']}",
        f"  Approved    : {stats['approved']}",
        f"  Published   : {stats['published']}",
        '',
        'Recent Projects (last 30 days)',
    ]
    from datetime import timedelta
    cutoff = timezone.now() - timedelta(days=30)
    for p in projects.filter(created_at__gte=cutoff).order_by('-created_at')[:10]:
        lines.append(f'  [{p.status}] {p.project_number} — {p.name}')

    lines += ['', '---', 'Sent by RakshaGIS automated reporting system.']
    return '\n'.join(lines)


def _calc_next_run(frequency, from_dt):
    import datetime
    if frequency == 'DAILY':
        return from_dt + datetime.timedelta(days=1)
    if frequency == 'WEEKLY':
        return from_dt + datetime.timedelta(weeks=1)
    # MONTHLY
    if from_dt.month == 12:
        return from_dt.replace(year=from_dt.year + 1, month=1)
    return from_dt.replace(month=from_dt.month + 1)
