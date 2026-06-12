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
            elif schedule.report_type == 'SURVEY_STATS':
                _send_ministry_report(schedule, recipients, now, 'SURVEY_STATS')
            elif schedule.report_type == 'OWNERSHIP_SUM':
                _send_ministry_report(schedule, recipients, now, 'OWNERSHIP_SUM')
            elif schedule.report_type == 'ENCROACHMENT':
                _send_ministry_report(schedule, recipients, now, 'ENCROACHMENT')
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


# ── Ministry-format report suite ─────────────────────────────────────────────

_MINISTRY_FILENAMES = {
    'SURVEY_STATS': 'survey-statistics',
    'OWNERSHIP_SUM': 'ownership-summary',
    'ENCROACHMENT': 'encroachment-analysis',
}
_MINISTRY_SUBJECTS = {
    'SURVEY_STATS': 'Ministry Survey Statistics',
    'OWNERSHIP_SUM': 'Ministry Ownership Summary',
    'ENCROACHMENT': 'Ministry Encroachment Analysis',
}


def _send_ministry_report(schedule, recipients, now, report_type):
    builders = {
        'SURVEY_STATS': _build_survey_stats_pdf,
        'OWNERSHIP_SUM': _build_ownership_summary_pdf,
        'ENCROACHMENT': _build_encroachment_analysis_pdf,
    }
    pdf_bytes = builders[report_type](schedule, now)
    label = _MINISTRY_SUBJECTS[report_type]
    subject = f'RakshaGIS {label}: {schedule.name} — {now.strftime("%d %b %Y")}'
    body = (
        f'RakshaGIS {label}\n'
        f'Schedule    : {schedule.name}\n'
        f'Organisation: {schedule.organisation.name}\n'
        f'Generated   : {now.strftime("%d %B %Y %H:%M UTC")}\n\n'
        f'The ministry-format PDF is attached.\n\n'
        f'— RakshaGIS automated reporting system'
    )
    msg = EmailMessage(subject=subject, body=body,
                       from_email=settings.DEFAULT_FROM_EMAIL, to=recipients)
    if pdf_bytes:
        slug = _MINISTRY_FILENAMES[report_type]
        msg.attach(f'{slug}-{now.strftime("%Y%m%d")}.pdf', pdf_bytes, 'application/pdf')
    msg.send(fail_silently=True)


def _ministry_table_style(dark_blue, light_grey, grid_grey, total_row=False):
    base = [
        ('BACKGROUND', (0, 0), (-1, 0), dark_blue),
        ('TEXTCOLOR', (0, 0), (-1, 0), 'white'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), ['white', light_grey]),
        ('GRID', (0, 0), (-1, -1), 0.5, grid_grey),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
    ]
    if total_row:
        base += [
            ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
            ('BACKGROUND', (0, -1), (-1, -1), '#e8eef4'),
        ]
    return base


def _ministry_pdf_setup(schedule, now, title, buf):
    """Return (doc, styles dict, story with header) for a ministry PDF."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, HRFlowable

    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=2*cm, rightMargin=2*cm,
                            topMargin=2*cm, bottomMargin=2*cm)
    base = getSampleStyleSheet()
    DARK_BLUE = colors.HexColor('#1a2a4a')
    s = {
        'title': ParagraphStyle('T', parent=base['Heading1'], fontSize=16,
                                spaceAfter=4, textColor=DARK_BLUE),
        'sub': ParagraphStyle('S', parent=base['Normal'], fontSize=9, textColor=colors.grey),
        'h': ParagraphStyle('H', parent=base['Heading3'], fontSize=11,
                            textColor=DARK_BLUE, spaceBefore=10),
        'warn': ParagraphStyle('W', parent=base['Normal'], fontSize=9,
                               textColor=colors.HexColor('#c0392b')),
        'DARK_BLUE': DARK_BLUE,
        'LIGHT_GREY': colors.HexColor('#f5f5f5'),
        'GRID_GREY': colors.HexColor('#cccccc'),
        'cm': cm,
        'colors': colors,
    }
    story = [
        Paragraph('Ministry of Defence — Defence Geo-Data Engine (DGDE)', s['sub']),
        Paragraph(title, s['title']),
        Paragraph(
            f'Organisation: <b>{schedule.organisation.name}</b> &nbsp;|&nbsp; '
            f'Generated: {now.strftime("%d %B %Y %H:%M UTC")} &nbsp;|&nbsp; '
            f'Schedule: <b>{schedule.name}</b>',
            s['sub'],
        ),
        HRFlowable(width='100%', thickness=1, color=DARK_BLUE, spaceAfter=8),
    ]
    return doc, s, story


def _build_survey_stats_pdf(schedule, now):
    """Survey statistics: project counts by status/type, area totals, feature breakdown, monthly trend."""
    try:
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
        )
        import io
    except ImportError:
        return None

    from apps.survey_projects.models import SurveyProject, GISFeature
    from django.db.models import Count, Q, Sum
    from datetime import timedelta

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
    total_area = float(projects.aggregate(s=Sum('total_area_hectares'))['s'] or 0)
    type_stats = (
        projects.values('survey_type')
        .annotate(count=Count('id'), area=Sum('total_area_hectares'))
        .order_by('survey_type')
    )
    TYPE_LABELS = {
        'BOUNDARY': 'Boundary Survey', 'TOPOGRAPHIC': 'Topographic Survey',
        'CANTONMENT': 'Cantonment Survey', 'REVENUE': 'Revenue Survey',
        'LAYOUT': 'Layout Survey',
    }
    features = GISFeature.objects.filter(project__organisation=org, is_deleted=False)
    feat = features.aggregate(
        total=Count('id'),
        points=Count('id', filter=Q(geometry_type='POINT')),
        lines=Count('id', filter=Q(geometry_type='LINE')),
        polygons=Count('id', filter=Q(geometry_type='POLYGON')),
    )
    monthly = []
    for i in range(5, -1, -1):
        m_start = (now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                   if i == 0 else None)
        if i > 0:
            import calendar
            shifted = now.month - i
            year = now.year + (shifted - 1) // 12
            month = ((shifted - 1) % 12) + 1
            m_start = now.replace(year=year, month=month, day=1,
                                  hour=0, minute=0, second=0, microsecond=0)
        next_month = m_start.month % 12 + 1
        next_year = m_start.year + (1 if m_start.month == 12 else 0)
        m_end = m_start.replace(year=next_year, month=next_month)
        count = projects.filter(created_at__gte=m_start, created_at__lt=m_end).count()
        monthly.append((m_start.strftime('%b %Y'), count))

    buf = io.BytesIO()
    doc, s, story = _ministry_pdf_setup(schedule, now, 'Survey Statistics Report', buf)
    DARK_BLUE, LIGHT_GREY, GRID_GREY = s['DARK_BLUE'], s['LIGHT_GREY'], s['GRID_GREY']

    def tbl(data, widths, total=False):
        t = Table(data, colWidths=widths)
        t.setStyle(TableStyle(_ministry_table_style(DARK_BLUE, LIGHT_GREY, GRID_GREY, total)))
        return t

    total = status_stats['total'] or 1
    story += [
        Paragraph('1. Project Status Distribution', s['h']),
        tbl([
            ['Status', 'Count', '% of Total'],
            ['Draft',        str(status_stats['draft']),        f"{100*status_stats['draft']//total}%"],
            ['Submitted',    str(status_stats['submitted']),    f"{100*status_stats['submitted']//total}%"],
            ['Under Review', str(status_stats['under_review']), f"{100*status_stats['under_review']//total}%"],
            ['Approved',     str(status_stats['approved']),     f"{100*status_stats['approved']//total}%"],
            ['Published',    str(status_stats['published']),    f"{100*status_stats['published']//total}%"],
            ['TOTAL',        str(status_stats['total']),        '100%'],
        ], [8*cm, 4*cm, 3*cm], total=True),
        Spacer(1, 0.3*cm),
        Paragraph('2. Survey Type Breakdown', s['h']),
    ]
    type_data = [['Survey Type', 'Projects', 'Area (ha)']]
    for row in type_stats:
        type_data.append([TYPE_LABELS.get(row['survey_type'], row['survey_type']),
                          str(row['count']), f"{float(row['area'] or 0):,.2f}"])
    type_data.append(['TOTAL', str(status_stats['total']), f"{total_area:,.2f}"])
    story += [
        tbl(type_data, [8*cm, 4*cm, 3*cm], total=True),
        Spacer(1, 0.3*cm),
        Paragraph('3. GIS Feature Statistics', s['h']),
        tbl([
            ['Geometry Type', 'Count', '% of Total'],
            ['Points',              str(feat['points']),   f"{100*(feat['points'] or 0)//(feat['total'] or 1)}%"],
            ['Lines (Boundaries)',  str(feat['lines']),    f"{100*(feat['lines'] or 0)//(feat['total'] or 1)}%"],
            ['Polygons (Parcels)',  str(feat['polygons']), f"{100*(feat['polygons'] or 0)//(feat['total'] or 1)}%"],
            ['TOTAL',              str(feat['total']),     '100%'],
        ], [8*cm, 4*cm, 3*cm], total=True),
        Spacer(1, 0.3*cm),
        Paragraph('4. Monthly Project Creation (Last 6 Months)', s['h']),
        tbl([['Month', 'New Projects']] + [[m, str(c)] for m, c in monthly], [9*cm, 6*cm]),
        Spacer(1, 0.8*cm),
        HRFlowable(width='100%', thickness=0.5, color=s['colors'].grey),
        Spacer(1, 0.2*cm),
        Paragraph('Generated by RakshaGIS Automated Reporting — Defence Geo-Data Engine (DGDE). '
                  'Classification: FOR OFFICIAL USE ONLY.', s['sub']),
    ]
    doc.build(story)
    return buf.getvalue()


def _build_ownership_summary_pdf(schedule, now):
    """Ownership summary: DefenceParcel holdings by category, classification and area."""
    try:
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
        )
        import io
    except ImportError:
        return None

    from apps.survey_projects.models import DefenceParcel
    from django.db.models import Count, Sum
    from datetime import timedelta

    org = schedule.organisation
    parcels = DefenceParcel.objects.filter(organisation=org)
    total_parcels = parcels.count()
    total_ha = float(parcels.aggregate(s=Sum('area_hectares'))['s'] or 0)

    CATEGORY_LABELS = {
        'CANTONMENT': 'Cantonment', 'RANGE': 'Firing / Training Range',
        'AIRFIELD': 'Airfield / Helipad', 'DEPOT': 'Depot / Storehouse',
        'TRAINING_AREA': 'Training Area', 'HOSPITAL': 'Military Hospital',
        'OFFICE': 'Office / HQ', 'RESIDENTIAL': 'Residential Colony', 'OTHER': 'Other',
    }
    CLASS_LABELS = {
        'UNCLASSIFIED': 'Unclassified', 'RESTRICTED': 'Restricted',
        'CONFIDENTIAL': 'Confidential', 'SECRET': 'Secret',
    }
    cat_stats = (parcels.values('category')
                 .annotate(count=Count('id'), area=Sum('area_hectares'))
                 .order_by('category'))
    class_stats = (parcels.values('classification')
                   .annotate(count=Count('id'), area=Sum('area_hectares'))
                   .order_by('classification'))
    recent = list(
        parcels.filter(created_at__gte=now - timedelta(days=30))
        .order_by('-created_at')
        .values('parcel_id', 'name', 'category', 'area_hectares')[:10]
    )

    buf = io.BytesIO()
    doc, s, story = _ministry_pdf_setup(schedule, now, 'Defence Land Ownership Summary Report', buf)
    DARK_BLUE, LIGHT_GREY, GRID_GREY = s['DARK_BLUE'], s['LIGHT_GREY'], s['GRID_GREY']
    total_ha_safe = total_ha or 0.001

    def tbl(data, widths, total=False):
        t = Table(data, colWidths=widths)
        t.setStyle(TableStyle(_ministry_table_style(DARK_BLUE, LIGHT_GREY, GRID_GREY, total)))
        return t

    # Section 1: Category breakdown
    cat_data = [['Land Category', 'Parcels', 'Area (ha)', 'Area (acres)']]
    for row in cat_stats:
        ha = float(row['area'] or 0)
        cat_data.append([CATEGORY_LABELS.get(row['category'], row['category']),
                         str(row['count']), f"{ha:,.2f}", f"{ha * 2.47105:,.2f}"])
    cat_data.append(['TOTAL', str(total_parcels),
                     f"{total_ha:,.2f}", f"{total_ha * 2.47105:,.2f}"])

    # Section 2: Classification matrix
    cls_data = [['Classification', 'Parcels', 'Area (ha)', '% of Total']]
    for row in class_stats:
        ha = float(row['area'] or 0)
        cls_data.append([CLASS_LABELS.get(row['classification'], row['classification']),
                         str(row['count']), f"{ha:,.2f}", f"{100*ha/total_ha_safe:.1f}%"])

    story += [
        Paragraph('1. Holdings by Land Category', s['h']),
        tbl(cat_data, [7*cm, 2.5*cm, 3*cm, 3*cm], total=True),
        Spacer(1, 0.3*cm),
        Paragraph('2. Classification Matrix', s['h']),
        tbl(cls_data, [7*cm, 2.5*cm, 3*cm, 3*cm]),
    ]

    if recent:
        recent_data = [['Parcel ID', 'Name', 'Category', 'Area (ha)']]
        for p in recent:
            recent_data.append([p['parcel_id'] or '—', (p['name'] or '')[:35],
                                 CATEGORY_LABELS.get(p['category'], p['category']),
                                 f"{float(p['area_hectares'] or 0):,.2f}"])
        story += [
            Spacer(1, 0.3*cm),
            Paragraph('3. Recently Registered Parcels (Last 30 Days)', s['h']),
            tbl(recent_data, [3*cm, 6*cm, 4*cm, 2.5*cm]),
        ]

    story += [
        Spacer(1, 0.8*cm),
        HRFlowable(width='100%', thickness=0.5, color=s['colors'].grey),
        Spacer(1, 0.2*cm),
        Paragraph('Generated by RakshaGIS Automated Reporting — Defence Geo-Data Engine (DGDE). '
                  'Classification: FOR OFFICIAL USE ONLY.', s['sub']),
    ]
    doc.build(story)
    return buf.getvalue()


def _build_encroachment_analysis_pdf(schedule, now):
    """Encroachment analysis: DisputeReport counts, overlap areas, open vs acknowledged."""
    try:
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
        )
        import io
    except ImportError:
        return None

    from apps.workflow.models import DisputeReport
    from apps.survey_projects.models import SurveyArea
    from django.db.models import Count

    org = schedule.organisation
    area_ids = list(
        SurveyArea.objects.filter(project__organisation=org).values_list('id', flat=True)
    )
    disputes_qs = DisputeReport.objects.filter(survey_area_id__in=area_ids)
    total_reports = disputes_qs.count()
    disputed_count = disputes_qs.filter(status='HAS_DISPUTES').count()
    clean_count = disputes_qs.filter(status='CLEAN').count()
    open_qs = disputes_qs.filter(status='HAS_DISPUTES', acknowledged=False)
    acked_qs = disputes_qs.filter(status='HAS_DISPUTES', acknowledged=True)

    total_overlap_sqm = 0.0
    open_rows = []
    for dr in open_qs.select_related('survey_area__project').order_by('-checked_at')[:50]:
        row_overlap = sum(float(d.get('overlap_sqm', 0)) for d in (dr.disputes or []))
        total_overlap_sqm += row_overlap
        open_rows.append({
            'area': dr.survey_area.name,
            'project': (dr.survey_area.project.project_number or dr.survey_area.project.name),
            'dispute_count': len(dr.disputes or []),
            'overlap_sqm': row_overlap,
            'date': dr.checked_at.strftime('%d %b %Y'),
        })
    for dr in acked_qs.order_by('-checked_at')[:100]:
        total_overlap_sqm += sum(float(d.get('overlap_sqm', 0)) for d in (dr.disputes or []))

    buf = io.BytesIO()
    doc, s, story = _ministry_pdf_setup(schedule, now, 'Encroachment Analysis Report', buf)
    DARK_BLUE, LIGHT_GREY, GRID_GREY = s['DARK_BLUE'], s['LIGHT_GREY'], s['GRID_GREY']

    def tbl(data, widths):
        t = Table(data, colWidths=widths)
        t.setStyle(TableStyle(_ministry_table_style(DARK_BLUE, LIGHT_GREY, GRID_GREY)))
        return t

    summary_data = [
        ['Metric', 'Value'],
        ['Total spatial overlap checks run',      str(total_reports)],
        ['Survey areas: Clean (no disputes)',      str(clean_count)],
        ['Survey areas: Disputes detected',        str(disputed_count)],
        ['Open (unacknowledged) dispute reports',  str(open_qs.count())],
        ['Acknowledged dispute reports',           str(acked_qs.count())],
        ['Total overlapping area (sq. m)',         f"{total_overlap_sqm:,.1f}"],
        ['Total overlapping area (ha)',            f"{total_overlap_sqm / 10000:,.4f}"],
    ]
    story += [
        Paragraph('1. Encroachment Summary', s['h']),
        tbl(summary_data, [11*cm, 4.5*cm]),
    ]

    if open_qs.count():
        story.append(Spacer(1, 0.2*cm))
        story.append(Paragraph(
            f'WARNING: {open_qs.count()} dispute report(s) remain unacknowledged and require attention.',
            s['warn'],
        ))

    if open_rows:
        open_data = [['Survey Area', 'Project No.', 'Disputes', 'Overlap (sq.m)', 'Detected']]
        for r in open_rows:
            open_data.append([r['area'][:30], r['project'][:20],
                              str(r['dispute_count']), f"{r['overlap_sqm']:,.1f}", r['date']])
        story += [
            Spacer(1, 0.3*cm),
            Paragraph('2. Open (Unacknowledged) Encroachments', s['h']),
            tbl(open_data, [5*cm, 3.5*cm, 2*cm, 3.5*cm, 2.5*cm]),
        ]

    acked_rows = list(
        acked_qs.select_related('survey_area__project', 'acknowledged_by')
        .order_by('-acknowledged_at')[:20]
    )
    if acked_rows:
        acked_data = [['Survey Area', 'Project No.', 'Disputes', 'Acknowledged By', 'Date']]
        for dr in acked_rows:
            acked_data.append([
                dr.survey_area.name[:28],
                (dr.survey_area.project.project_number or dr.survey_area.project.name)[:20],
                str(len(dr.disputes or [])),
                str(dr.acknowledged_by or '—')[:25],
                dr.acknowledged_at.strftime('%d %b %Y') if dr.acknowledged_at else '—',
            ])
        story += [
            Spacer(1, 0.3*cm),
            Paragraph('3. Acknowledged Encroachments (Most Recent)', s['h']),
            tbl(acked_data, [4.5*cm, 3*cm, 2*cm, 4*cm, 3*cm]),
        ]

    story += [
        Spacer(1, 0.8*cm),
        HRFlowable(width='100%', thickness=0.5, color=s['colors'].grey),
        Spacer(1, 0.2*cm),
        Paragraph('Generated by RakshaGIS Automated Reporting — Defence Geo-Data Engine (DGDE). '
                  'Classification: FOR OFFICIAL USE ONLY.', s['sub']),
    ]
    doc.build(story)
    return buf.getvalue()


def _calc_next_run(frequency, from_dt):
    import datetime
    if frequency == 'DAILY':
        return from_dt + datetime.timedelta(days=1)
    if frequency == 'WEEKLY':
        return from_dt + datetime.timedelta(weeks=1)
    if from_dt.month == 12:
        return from_dt.replace(year=from_dt.year + 1, month=1)
    return from_dt.replace(month=from_dt.month + 1)
