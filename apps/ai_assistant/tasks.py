import os

from celery import shared_task
from django.utils import timezone


@shared_task(bind=True, max_retries=2)
def process_document_ai(self, task_id: int):
    """
    1. Extract text from document (PDF via pdfplumber).
    2. Summarise with Ollama.
    3. Store summary + extracted text on the Document record.
    """
    from django.conf import settings
    from apps.ai_assistant.models import AITask
    from apps.ai_assistant.services import OllamaService
    from apps.documents.models import Document

    task = AITask.objects.get(id=task_id)
    task.status = AITask.RUNNING
    task.save(update_fields=['status'])

    try:
        document = Document.objects.get(id=task.input_data['document_id'])
        file_path = os.path.join(settings.MEDIA_ROOT, document.file.name)

        # ── Step 1: Extract text ──────────────────────────────────────
        text = ''
        if document.mime_type == 'application/pdf':
            import pdfplumber
            with pdfplumber.open(file_path) as pdf:
                pages = [p.extract_text() or '' for p in pdf.pages]
            text = '\n'.join(pages)
        # Future: elif 'image/' in document.mime_type: OCR via pytesseract

        document.extracted_text = text[:50_000]  # cap at 50 k chars
        document.save(update_fields=['extracted_text'])

        # ── Step 2: Summarise ─────────────────────────────────────────
        service = OllamaService()
        source  = text or f"Document: {document.title} ({document.get_category_display()})"
        summary = service.summarize_document(source)

        document.ai_summary   = summary
        document.ai_processed = True
        document.save(update_fields=['ai_summary', 'ai_processed'])

        task.status = AITask.DONE
        task.result = {'summary_length': len(summary), 'text_length': len(text)}

    except Exception as exc:
        task.status      = AITask.FAILED
        task.error_message = str(exc)
        self.retry(exc=exc, countdown=30)

    finally:
        task.completed_at = timezone.now()
        task.save(update_fields=['status', 'result', 'error_message', 'completed_at'])


@shared_task(bind=True, max_retries=1)
def generate_project_report(self, task_id: int):
    """
    Collect project data (features, docs, workflow history) and generate an
    inspection report via Ollama. Store the report text and file path in the task.
    """
    from django.conf import settings
    from apps.ai_assistant.models import AITask
    from apps.ai_assistant.services import OllamaService
    from apps.survey_projects.models import SurveyProject
    from apps.core.folder_manager import get_project_rel_path

    task = AITask.objects.get(id=task_id)
    task.status = AITask.RUNNING
    task.save(update_fields=['status'])

    try:
        project = SurveyProject.objects.select_related(
            'organisation', 'state', 'district', 'taluk', 'village', 'created_by'
        ).get(id=task.input_data['project_id'])

        # Build context dict
        workflow_steps = list(
            project.workflow_steps.select_related('actor')
            .values('action', 'actor__username', 'remarks', 'timestamp')
            .order_by('timestamp')
        )
        project_data = {
            'project_number':   project.project_number,
            'name':             project.name,
            'description':      project.description,
            'organisation':     str(project.organisation),
            'status':           project.get_status_display(),
            'survey_type':      project.get_survey_type_display(),
            'state':            str(project.state) if project.state else None,
            'district':         str(project.district) if project.district else None,
            'start_date':       str(project.start_date) if project.start_date else None,
            'target_date':      str(project.target_date) if project.target_date else None,
            'total_area_ha':    str(project.total_area_hectares) if project.total_area_hectares else None,
            'feature_count':    project.features.filter(is_deleted=False).count(),
            'document_count':   project.documents.count(),
            'workflow_history': workflow_steps,
        }

        service = OllamaService()
        report_text = service.generate_inspection_report(project_data)

        # Save report to exports directory
        rel_path = get_project_rel_path(project)
        export_dir = os.path.join(settings.MEDIA_ROOT, rel_path, 'exports')
        os.makedirs(export_dir, exist_ok=True)

        ts = timezone.now().strftime('%Y%m%d_%H%M%S')
        report_filename = f"inspection_report_{ts}.txt"
        report_path = os.path.join(export_dir, report_filename)

        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(report_text)

        task.status = AITask.DONE
        task.result = {
            'report_text':    report_text,
            'file_rel_path':  f"{rel_path}/exports/{report_filename}",
        }

    except Exception as exc:
        task.status        = AITask.FAILED
        task.error_message = str(exc)
        self.retry(exc=exc, countdown=30)

    finally:
        task.completed_at = timezone.now()
        task.save(update_fields=['status', 'result', 'error_message', 'completed_at'])
