from celery import shared_task
from django.core.mail import send_mail, EmailMessage
from django.utils import timezone
from django.conf import settings


@shared_task(name='apps.reports.tasks.send_scheduled_reports')
def send_scheduled_reports():
    """Run daily. Sends any ReportSchedule whose next_run is past due."""
    from .models import ReportSchedule
    from django.db.models import Q

    now = timezone.now()
    due = ReportSchedule.objects.filter(is_active=True).filter(
        Q(next_run__isnull=True) | Q(next_run__lte=now)
    ).select_related('organisation')

    for schedule in due:
        try:
            recipients = [e.strip() for e in schedule.recipients.split(',') if e.strip()]
            if not recipients:
                continue

            if schedule.report_type == 'TERRAIN_SUMMARY':
                _send_terrain_report(schedule, recipients, now)
            elif schedule.report_type == 'AI_SUMMARY':
                _send_ai_summary_report(schedule, recipients, now)
            else:
                body = _build_report_body(schedule)
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


def _send_terrain_report(schedule, recipients, now):
    """Generate a terrain summary PDF attachment and email it."""
    filters = schedule.filters or {}
    bbox = filters.get('bbox')            # [minLon,minLat,maxLon,maxLat] or None
    area_name = filters.get('area_name', 'Watched Area')

    pdf_bytes = _build_terrain_pdf(schedule, bbox, area_name, now)
    subject = f'RakshaGIS Terrain Report: {schedule.name} — {now.strftime("%d %b %Y")}'
    body = (
        f'RakshaGIS Terrain Analysis Report\n'
        f'Schedule : {schedule.name}\n'
        f'Area     : {area_name}\n'
        f'Generated: {now.strftime("%d %B %Y %H:%M UTC")}\n\n'
        f'Please find the terrain summary PDF attached.\n\n'
        f'— RakshaGIS automated reporting system'
    )
    msg = EmailMessage(
        subject=subject,
        body=body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=recipients,
    )
    if pdf_bytes:
        filename = f'terrain-report-{now.strftime("%Y%m%d")}.pdf'
        msg.attach(filename, pdf_bytes, 'application/pdf')
    msg.send(fail_silently=True)


def _build_terrain_pdf(schedule, bbox, area_name, now):
    """Build a single-page terrain summary PDF using reportlab."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
        )
        import io
    except ImportError:
        return None

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=2*cm, rightMargin=2*cm,
                            topMargin=2*cm, bottomMargin=2*cm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('title', parent=styles['Heading1'],
                                 fontSize=18, spaceAfter=6,
                                 textColor=colors.HexColor('#1a2a4a'))
    sub_style = ParagraphStyle('sub', parent=styles['Normal'],
                               fontSize=10, textColor=colors.grey)
    body_style = styles['Normal']
    body_style.fontSize = 10

    from apps.survey_projects.models import SurveyProject
    from django.db.models import Count, Q

    org = schedule.organisation
    projects = SurveyProject.objects.filter(organisation=org)
    stats = projects.aggregate(
        total=Count('id'),
        draft=Count('id', filter=Q(status='DRAFT')),
        submitted=Count('id', filter=Q(status='SUBMITTED')),
        under_review=Count('id', filter=Q(status='UNDER_REVIEW')),
        approved=Count('id', filter=Q(status='APPROVED')),
        published=Count('id', filter=Q(status='PUBLISHED')),
    )

    story = []
    story.append(Paragraph('RakshaGIS — Terrain Analysis Report', title_style))
    story.append(Paragraph(
        f'Schedule: <b>{schedule.name}</b> &nbsp;|&nbsp; '
        f'Organisation: <b>{org.name}</b> &nbsp;|&nbsp; '
        f'Generated: {now.strftime("%d %B %Y %H:%M UTC")}',
        sub_style,
    ))
    story.append(HRFlowable(width='100%', thickness=1, color=colors.HexColor('#1a2a4a'),
                             spaceAfter=10))

    # Area info
    story.append(Paragraph(f'<b>Watched Area:</b> {area_name}', body_style))
    if bbox:
        lon0, lat0, lon1, lat1 = bbox
        story.append(Paragraph(
            f'Bounding Box: ({lat0:.4f}°N, {lon0:.4f}°E) → ({lat1:.4f}°N, {lon1:.4f}°E)',
            sub_style,
        ))
    story.append(Spacer(1, 0.4*cm))

    # Project status table
    story.append(Paragraph('<b>Project Status Summary</b>', body_style))
    story.append(Spacer(1, 0.2*cm))
    tdata = [
        ['Status', 'Count'],
        ['Total Projects', str(stats['total'])],
        ['Draft',          str(stats['draft'])],
        ['Submitted',      str(stats['submitted'])],
        ['Under Review',   str(stats['under_review'])],
        ['Approved',       str(stats['approved'])],
        ['Published',      str(stats['published'])],
    ]
    t = Table(tdata, colWidths=[10*cm, 4*cm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1a2a4a')),
        ('TEXTCOLOR',  (0,0), (-1,0), colors.white),
        ('FONTNAME',   (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',   (0,0), (-1,-1), 9),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f5f5f5')]),
        ('GRID',       (0,0), (-1,-1), 0.5, colors.HexColor('#cccccc')),
        ('ALIGN',      (1,0), (1,-1), 'CENTER'),
        ('LEFTPADDING',  (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.5*cm))

    # Recent projects
    from datetime import timedelta
    cutoff = now - timedelta(days=30)
    recent = list(projects.filter(created_at__gte=cutoff).order_by('-created_at')[:8])
    if recent:
        story.append(Paragraph('<b>Recent Projects (last 30 days)</b>', body_style))
        story.append(Spacer(1, 0.2*cm))
        rdata = [['Project No.', 'Name', 'Status', 'Created']]
        for p in recent:
            rdata.append([
                p.project_number or '—',
                (p.name or '')[:40],
                p.status,
                p.created_at.strftime('%d %b %Y'),
            ])
        rt = Table(rdata, colWidths=[3*cm, 7*cm, 3*cm, 3*cm])
        rt.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#2a4a6a')),
            ('TEXTCOLOR',  (0,0), (-1,0), colors.white),
            ('FONTNAME',   (0,0), (-1,0), 'Helvetica-Bold'),
            ('FONTSIZE',   (0,0), (-1,-1), 8),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f5f5f5')]),
            ('GRID',       (0,0), (-1,-1), 0.5, colors.HexColor('#cccccc')),
            ('LEFTPADDING',  (0,0), (-1,-1), 6),
        ]))
        story.append(rt)

    story.append(Spacer(1, 0.8*cm))
    story.append(HRFlowable(width='100%', thickness=0.5, color=colors.grey))
    story.append(Spacer(1, 0.2*cm))
    story.append(Paragraph(
        'Generated by RakshaGIS Automated Reporting — Defence Geo-Data Engine (DGDE)',
        sub_style,
    ))

    doc.build(story)
    return buf.getvalue()


# ── AI Survey Summary report ──────────────────────────────────────────────────

def _gather_ai_summary_stats(schedule, now):
    """Collect organisation-level survey statistics for the LLM prompt."""
    from datetime import timedelta
    from django.db.models import Count, Q, Sum
    from apps.survey_projects.models import SurveyProject, GISFeature

    org = schedule.organisation
    projects = SurveyProject.objects.filter(organisation=org)
    status_stats = projects.aggregate(
        total=Count('id'),
        draft=Count('id', filter=Q(status='DRAFT')),
        submitted=Count('id', filter=Q(status='SUBMITTED')),
        under_review=Count('id', filter=Q(status='UNDER_REVIEW')),
        approved=Count('id', filter=Q(status='APPROVED')),
        published=Count('id', filter=Q(status='PUBLISHED')),
    )
    total_area = projects.aggregate(s=Sum('total_area_hectares'))['s']

    features = GISFeature.objects.filter(project__organisation=org, is_deleted=False)
    feature_stats = features.aggregate(
        total=Count('id'),
        points=Count('id', filter=Q(geometry_type='POINT')),
        lines=Count('id', filter=Q(geometry_type='LINE')),
        polygons=Count('id', filter=Q(geometry_type='POLYGON')),
    )
    cutoff = now - timedelta(days=30)
    recent_features = features.filter(created_at__gte=cutoff).count()
    recent_projects = list(
        projects.filter(created_at__gte=cutoff)
        .order_by('-created_at')
        .values('project_number', 'name', 'status', 'created_at')[:10]
    )
    timeline = [
        {
            'project': p['project_number'] or p['name'],
            'status': p['status'],
            'created': p['created_at'].strftime('%d %b %Y'),
        } for p in recent_projects
    ]
    return {
        'organisation': org.name,
        'period_end': now.strftime('%d %B %Y'),
        'projects': status_stats,
        'total_area_hectares': float(total_area) if total_area else None,
        'features': feature_stats,
        'features_added_last_30_days': recent_features,
        'recent_projects': timeline,
    }


def _ai_narrative(stats: dict) -> str:
    """Generate the narrative via the local LLM; deterministic fallback if down."""
    import json
    try:
        from apps.ai_assistant.services import OllamaService
        service = OllamaService()
        if service.is_available():
            system = (
                'You are a senior GIS analyst at the Defence Geo-Data Engine (DGDE) '
                'writing an executive survey-progress summary for commanding officers. '
                'Write 4-6 concise paragraphs of plain prose (no markdown, no bullet '
                'lists, no headings). Cover overall progress, workflow pipeline state, '
                'mapping activity (feature counts and area), notable recent projects, '
                'and one closing recommendation. Use only the data provided — never '
                'invent numbers.'
            )
            prompt = 'Survey statistics (JSON):\n' + json.dumps(stats, indent=2)
            text = (service.generate(prompt, system) or '').strip()
            if text:
                return text
    except Exception:
        pass

    # Fallback narrative — keeps scheduled reports flowing when the LLM is down
    p, f = stats['projects'], stats['features']
    area = stats['total_area_hectares']
    return (
        f"As of {stats['period_end']}, {stats['organisation']} manages "
        f"{p['total']} survey projects: {p['draft']} in draft, {p['submitted']} submitted, "
        f"{p['under_review']} under review, {p['approved']} approved and "
        f"{p['published']} published.\n\n"
        f"The geodatabase holds {f['total']} active features "
        f"({f['points']} points, {f['lines']} lines, {f['polygons']} polygons)"
        + (f" covering approximately {area:,.1f} hectares" if area else '') + ". "
        f"{stats['features_added_last_30_days']} features were added in the last 30 days.\n\n"
        f"(AI narrative unavailable — the local language model could not be reached; "
        f"this is an automatically generated statistical summary.)"
    )


def _send_ai_summary_report(schedule, recipients, now):
    """AI-generated narrative survey report: stats → Ollama → PDF → email."""
    stats = _gather_ai_summary_stats(schedule, now)
    narrative = _ai_narrative(stats)

    # Track the generation as an AITask for the AI activity dashboard
    try:
        from apps.ai_assistant.models import AITask
        AITask.objects.create(
            task_type=AITask.REPORT_GENERATION,
            status=AITask.DONE,
            requested_by=schedule.created_by,
            input_data={'schedule_id': schedule.id, 'organisation': stats['organisation']},
            result={'narrative': narrative},
            completed_at=now,
        )
    except Exception:
        pass

    pdf_bytes = _build_ai_summary_pdf(schedule, stats, narrative, now)
    subject = f'RakshaGIS AI Survey Summary: {schedule.name} — {now.strftime("%d %b %Y")}'
    body = (
        f'RakshaGIS AI Survey Summary\n'
        f'Schedule : {schedule.name}\n'
        f'Organisation: {stats["organisation"]}\n'
        f'Generated: {now.strftime("%d %B %Y %H:%M UTC")}\n\n'
        f'The AI-generated survey summary PDF is attached.\n\n'
        f'— RakshaGIS automated reporting system'
    )
    msg = EmailMessage(subject=subject, body=body,
                       from_email=settings.DEFAULT_FROM_EMAIL, to=recipients)
    if pdf_bytes:
        msg.attach(f'ai-survey-summary-{now.strftime("%Y%m%d")}.pdf',
                   pdf_bytes, 'application/pdf')
    msg.send(fail_silently=True)


def _build_ai_summary_pdf(schedule, stats, narrative, now):
    """Narrative PDF: AI prose + statistics tables. LP-DNA watermarked."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
        )
        import io
    except ImportError:
        return None

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=2*cm, rightMargin=2*cm,
                            topMargin=2*cm, bottomMargin=2*cm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('title', parent=styles['Heading1'],
                                 fontSize=18, spaceAfter=6,
                                 textColor=colors.HexColor('#1a2a4a'))
    sub_style = ParagraphStyle('sub', parent=styles['Normal'],
                               fontSize=10, textColor=colors.grey)
    body_style = ParagraphStyle('body', parent=styles['Normal'],
                                fontSize=10, leading=15, spaceAfter=8)
    h_style = ParagraphStyle('h', parent=styles['Heading3'],
                             fontSize=12, textColor=colors.HexColor('#1a2a4a'))

    story = [
        Paragraph('RakshaGIS — AI Survey Summary', title_style),
        Paragraph(
            f'Schedule: <b>{schedule.name}</b> &nbsp;|&nbsp; '
            f'Organisation: <b>{stats["organisation"]}</b> &nbsp;|&nbsp; '
            f'Generated: {now.strftime("%d %B %Y %H:%M UTC")}',
            sub_style,
        ),
        HRFlowable(width='100%', thickness=1, color=colors.HexColor('#1a2a4a'), spaceAfter=10),
        Paragraph('Executive Summary', h_style),
    ]
    from xml.sax.saxutils import escape
    for para in narrative.split('\n\n'):
        para = para.strip()
        if para:
            story.append(Paragraph(escape(para).replace('\n', '<br/>'), body_style))
    story.append(Spacer(1, 0.3*cm))

    p, f = stats['projects'], stats['features']
    story.append(Paragraph('Key Figures', h_style))
    tdata = [
        ['Metric', 'Value'],
        ['Total projects', str(p['total'])],
        ['Draft / Submitted / Under review', f"{p['draft']} / {p['submitted']} / {p['under_review']}"],
        ['Approved / Published', f"{p['approved']} / {p['published']}"],
        ['Active features (pt / ln / pg)', f"{f['total']}  ({f['points']} / {f['lines']} / {f['polygons']})"],
        ['Features added (30 days)', str(stats['features_added_last_30_days'])],
        ['Total surveyed area', f"{stats['total_area_hectares']:,.1f} ha" if stats['total_area_hectares'] else '—'],
    ]
    t = Table(tdata, colWidths=[9*cm, 5*cm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a2a4a')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f5f5')]),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#cccccc')),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
    ]))
    story.append(t)

    if stats['recent_projects']:
        story.append(Spacer(1, 0.4*cm))
        story.append(Paragraph('Recent Projects (last 30 days)', h_style))
        rdata = [['Project', 'Status', 'Created']]
        for rp in stats['recent_projects']:
            rdata.append([str(rp['project'])[:45], rp['status'], rp['created']])
        rt = Table(rdata, colWidths=[8*cm, 3*cm, 3*cm])
        rt.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2a4a6a')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f5f5')]),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#cccccc')),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ]))
        story.append(rt)

    story.append(Spacer(1, 0.8*cm))
    story.append(HRFlowable(width='100%', thickness=0.5, color=colors.grey))
    story.append(Spacer(1, 0.2*cm))
    story.append(Paragraph(
        'Narrative generated by the RakshaGIS local AI assistant (offline LLM). '
        'Verify all figures against the live dashboard before operational use.',
        sub_style,
    ))
    doc.build(story)
    pdf_bytes = buf.getvalue()

    # LP-DNA legacy provenance watermark (same scheme as other PDF exports)
    try:
        from apps.core.watermark import embed_watermark
        pdf_bytes = embed_watermark(
            pdf_bytes, 'ai-survey-summary.pdf', 'application/pdf',
            {'source': 'RakshaGIS/AI-Report', 'schedule': schedule.name},
        )
    except Exception:
        pass
    return pdf_bytes


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
    if from_dt.month == 12:
        return from_dt.replace(year=from_dt.year + 1, month=1)
    return from_dt.replace(month=from_dt.month + 1)
