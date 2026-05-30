import json
import os
import tempfile
import zipfile

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


@shared_task(bind=True, max_retries=1)
def process_gis_file(self, task_id: int):
    """
    Read a GIS file (GeoJSON/KML/GPKG/SHP-zip/CSV), extract features + attributes as
    structured text, and inject it as a user message into the linked chat session so
    the AI has context about the uploaded data.
    """
    from apps.ai_assistant.models import AITask, ChatSession, ChatMessage

    task = AITask.objects.get(id=task_id)
    task.status = AITask.RUNNING
    task.save(update_fields=['status'])

    tmp_dir = None
    try:
        file_path = task.input_data['file_path']
        filename = task.input_data.get('filename', os.path.basename(file_path))
        session_id = task.input_data.get('session_id')

        ext = os.path.splitext(filename)[1].lower()
        actual_path = file_path

        if ext == '.zip':
            tmp_dir = tempfile.mkdtemp()
            with zipfile.ZipFile(file_path) as zf:
                zf.extractall(tmp_dir)
            shp_files = [os.path.join(tmp_dir, f) for f in os.listdir(tmp_dir) if f.endswith('.shp')]
            if not shp_files:
                raise ValueError('No .shp file found in ZIP archive.')
            actual_path = shp_files[0]
            ext = '.shp'

        try:
            import geopandas as gpd
            if ext == '.csv':
                import pandas as pd
                df = pd.read_csv(actual_path)
                feature_count = len(df)
                columns = list(df.columns)
                geom_type = 'Table (no geometry)'
                sample_text = df[columns].head(10).to_string()
            else:
                gdf = gpd.read_file(actual_path)
                feature_count = len(gdf)
                columns = [c for c in gdf.columns if c != 'geometry']
                geom_type = gdf.geom_type.iloc[0] if feature_count > 0 else 'unknown'
                sample_text = gdf[columns].head(10).to_string() if columns else '(no attributes)'
        except Exception as parse_err:
            if ext in ('.geojson', '.json'):
                with open(actual_path, encoding='utf-8') as fp:
                    data = json.load(fp)
                features_raw = data.get('features', [])
                feature_count = len(features_raw)
                columns = list(features_raw[0]['properties'].keys()) if features_raw else []
                geom_type = features_raw[0]['geometry']['type'] if features_raw else 'unknown'
                sample_text = '\n'.join(str(f['properties']) for f in features_raw[:10])
            else:
                raise parse_err

        context_lines = [
            f"GIS file uploaded: {filename}",
            f"Feature count: {feature_count}",
            f"Geometry type: {geom_type}",
            f"Attributes: {', '.join(columns) if columns else 'none'}",
            '',
            'Sample data (first 10 features):',
            sample_text,
        ]
        context_text = '\n'.join(context_lines)

        if session_id:
            session = ChatSession.objects.get(id=session_id)
            ChatMessage.objects.create(
                session=session,
                role=ChatMessage.USER,
                content=f"[GIS File Context — {filename}]\n{context_text}",
            )
            session.save(update_fields=['updated_at'])

        task.status = AITask.DONE
        task.result = {
            'feature_count': feature_count,
            'columns': columns,
            'geom_type': geom_type,
            'filename': filename,
        }

    except Exception as exc:
        task.status = AITask.FAILED
        task.error_message = str(exc)
        self.retry(exc=exc, countdown=30)

    finally:
        task.completed_at = timezone.now()
        task.save(update_fields=['status', 'result', 'error_message', 'completed_at'])
        if tmp_dir and os.path.isdir(tmp_dir):
            import shutil  # noqa: F811
            shutil.rmtree(tmp_dir, ignore_errors=True)


@shared_task(bind=True, max_retries=0)
def pull_model_task(self, task_id: int):
    """
    Pull / download a model from a supported hub into the target AI backend.
    Supported hubs: ollama, localai, huggingface, llamacpp (HuggingFace GGUF).
    """
    import os
    import time
    import httpx
    from django.conf import settings
    from apps.ai_assistant.models import AITask

    task = AITask.objects.get(id=task_id)
    task.status = AITask.RUNNING
    task.save(update_fields=['status'])

    try:
        hub = task.input_data.get('hub', 'ollama')
        model_name = task.input_data.get('model_name', '')
        endpoint_url = task.input_data.get('endpoint_url', '').rstrip('/')
        api_key = task.input_data.get('api_key', '')

        headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}

        if hub == 'ollama':
            # Ollama native pull — stream=False blocks until complete
            r = httpx.post(
                f"{endpoint_url}/api/pull",
                json={'model': model_name, 'stream': False},
                timeout=httpx.Timeout(10, read=3600),
            )
            r.raise_for_status()
            task.status = AITask.DONE
            task.result = {'model': model_name, 'hub': hub}

        elif hub == 'localai':
            # LocalAI gallery install then poll job
            r = httpx.post(
                f"{endpoint_url}/models/apply",
                json={'name': model_name},
                headers=headers,
                timeout=60,
            )
            r.raise_for_status()
            job_uuid = r.json().get('uuid', '')
            for _ in range(720):  # up to 60 min
                jr = httpx.get(f"{endpoint_url}/models/jobs/{job_uuid}", headers=headers, timeout=15)
                jr.raise_for_status()
                jd = jr.json()
                pct = jd.get('progress', 0)
                task.result = {'progress': pct, 'model': model_name, 'hub': hub}
                task.save(update_fields=['result'])
                if jd.get('processed'):
                    break
                time.sleep(5)
            task.status = AITask.DONE
            task.result = {'model': model_name, 'hub': hub, 'progress': 100}

        elif hub in ('huggingface', 'llamacpp'):
            # Download GGUF from HuggingFace → DATA_DIR/models/llamacpp/
            repo_id = task.input_data.get('repo_id', '')
            filename = task.input_data.get('filename', 'model.gguf')
            save_as = task.input_data.get('save_as', filename)
            hf_token = task.input_data.get('hf_token', '')

            data_dir = os.environ.get('DATA_DIR', getattr(settings, 'DATA_DIR', '/data'))
            dest_dir = os.path.join(data_dir, 'models', 'llamacpp')
            os.makedirs(dest_dir, exist_ok=True)
            dest_path = os.path.join(dest_dir, save_as)

            dl_headers = {}
            if hf_token:
                dl_headers['Authorization'] = f'Bearer {hf_token}'

            url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
            with httpx.stream('GET', url, headers=dl_headers, follow_redirects=True,
                              timeout=httpx.Timeout(30, read=7200)) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get('content-length', 0))
                done = 0
                with open(dest_path, 'wb') as f:
                    for chunk in resp.iter_bytes(1024 * 1024):
                        f.write(chunk)
                        done += len(chunk)
                        if total:
                            pct = min(99, round(done * 100 / total))
                            task.result = {
                                'progress': pct,
                                'downloaded_mb': round(done / 1024 ** 2),
                                'total_mb': round(total / 1024 ** 2),
                            }
                            task.save(update_fields=['result'])

            size_mb = round(os.path.getsize(dest_path) / 1024 ** 2)
            task.status = AITask.DONE
            task.result = {'model': save_as, 'hub': hub, 'size_mb': size_mb}

        else:
            raise ValueError(f"Unknown hub: {hub}")

    except Exception as exc:
        task.status = AITask.FAILED
        task.error_message = str(exc)

    finally:
        task.completed_at = timezone.now()
        task.save(update_fields=['status', 'result', 'error_message', 'completed_at'])


@shared_task(bind=True, max_retries=2)
def process_shapefile_ai(self, task_id: int):
    """
    Analyse a completed ShapefileImport: read its columns + sample features,
    generate an AI summary, and store it on the import record.
    """
    from apps.ai_assistant.models import AITask
    from apps.ai_assistant.services import OllamaService
    from apps.survey_projects.models import GISFeature, ShapefileImport

    task = AITask.objects.get(id=task_id)
    task.status = AITask.RUNNING
    task.save(update_fields=['status'])

    try:
        shp_import = ShapefileImport.objects.select_related('project').get(
            id=task.input_data['shapefile_import_id']
        )

        columns = shp_import.columns or []
        feature_count = shp_import.feature_count or 0

        # Grab a sample of features from GISFeature for this import's layer
        sample_features = list(
            GISFeature.objects.filter(
                project=shp_import.project,
                layer_name=shp_import.layer_name,
                is_deleted=False,
            ).values('feature_id', 'attributes')[:10]
        )
        sample_lines = [
            f"  {i+1}. id={f['feature_id']} attrs={json.dumps(f['attributes'])}"
            for i, f in enumerate(sample_features)
        ]

        context = (
            f"Layer: {shp_import.layer_name}\n"
            f"Project: {shp_import.project.name} ({shp_import.project.project_number})\n"
            f"Feature count: {feature_count}\n"
            f"Columns: {', '.join(columns) if columns else 'none'}\n"
            f"\nSample features:\n" + '\n'.join(sample_lines)
        )

        service = OllamaService()
        summary = service.generate(
            prompt=f"Analyse this imported GIS layer and provide a concise summary:\n\n{context}",
            system=(
                "You are a GIS data analyst for DGDE RakshaGIS. Summarise imported layers concisely: "
                "describe the data type, notable attributes, potential uses, and any data quality issues "
                "you can infer from the column names and sample records."
            ),
        )

        shp_import.ai_summary = summary
        shp_import.ai_processed = True
        shp_import.save(update_fields=['ai_summary', 'ai_processed'])

        task.status = AITask.DONE
        task.result = {'summary_length': len(summary), 'feature_count': feature_count}

    except Exception as exc:
        task.status = AITask.FAILED
        task.error_message = str(exc)
        self.retry(exc=exc, countdown=30)

    finally:
        task.completed_at = timezone.now()
        task.save(update_fields=['status', 'result', 'error_message', 'completed_at'])


# ── RAG: Document Embedding ───────────────────────────────────────────────────

@shared_task(bind=True, max_retries=1, name='ai_assistant.embed_document')
def embed_document(self, task_id: int):
    """
    Chunk a document's extracted text and generate embeddings via Ollama.
    Stores DocumentChunk records for RAG retrieval.
    """
    from apps.ai_assistant.models import AITask, DocumentChunk
    from apps.ai_assistant.services import LLMService, chunk_text
    from apps.documents.models import Document

    task = AITask.objects.get(id=task_id)
    task.status = AITask.RUNNING
    task.save(update_fields=['status'])

    try:
        doc_id   = task.input_data['document_id']
        model    = task.input_data.get('embed_model', 'nomic-embed-text')
        doc      = Document.objects.select_related('project').get(id=doc_id)
        text     = doc.ai_extracted_text or ''

        if not text.strip():
            task.status = AITask.DONE
            task.result = {'chunks': 0, 'reason': 'No extracted text found. Run AI processing first.'}
            task.completed_at = timezone.now()
            task.save(update_fields=['status', 'result', 'completed_at'])
            return

        chunks = chunk_text(text, chunk_size=500, overlap=60)
        svc    = LLMService()

        # Delete existing chunks for this document
        DocumentChunk.objects.filter(document=doc).delete()

        created = 0
        for idx, chunk_text_str in enumerate(chunks):
            embedding = svc.get_embedding(chunk_text_str, model=model)
            DocumentChunk.objects.create(
                document=doc,
                project=doc.project,
                chunk_index=idx,
                text=chunk_text_str,
                embedding=embedding,
                embed_model=model,
            )
            created += 1

        task.status = AITask.DONE
        task.result = {'chunks_created': created, 'model': model, 'doc_title': doc.title}
    except Exception as exc:
        task.status = AITask.FAILED
        task.error_message = str(exc)
    finally:
        task.completed_at = timezone.now()
        task.save(update_fields=['status', 'result', 'error_message', 'completed_at'])


# ── Vision: Boundary Extraction ───────────────────────────────────────────────

@shared_task(bind=True, max_retries=0, name='ai_assistant.extract_map_boundaries')
def extract_map_boundaries(self, job_id: int):
    """
    Send a scanned map image to a vision LLM (LLaVA / Ollama) and parse
    the response into parcel metadata + draft GeoJSON features.
    """
    import base64
    from datetime import timezone as dt_tz
    from datetime import datetime

    from apps.ai_assistant.models import BoundaryExtractionJob
    from apps.ai_assistant.services import LLMService

    job = BoundaryExtractionJob.objects.select_related('source_document', 'project').get(id=job_id)
    job.status = BoundaryExtractionJob.RUNNING
    job.save(update_fields=['status'])

    EXTRACTION_PROMPT = """You are analysing a scanned paper land survey / cadastral map from India
(DGDE Defence Estates). Extract all visible parcel and boundary information.

Return a JSON object with this exact structure:
{
  "map_info": {
    "title": "survey title or null",
    "scale": "e.g. 1:2000 or null",
    "district": "district name or null",
    "taluk": "taluk/tehsil name or null",
    "village": "village name or null",
    "date": "date on the map or null",
    "surveyor": "surveyor name or null",
    "north_arrow": "up/down/left/right/tilted or null"
  },
  "parcels": [
    {
      "survey_number": "plot/survey number visible on map",
      "area_text": "area as written on map (e.g. '2.5 ha' or '0.35 acres')",
      "shape": "rectangular/irregular/triangular/L-shaped/etc",
      "owner_text": "any ownership text visible",
      "adjacent_surveys": ["list of adjacent survey numbers"],
      "notes": "any other text inside this parcel"
    }
  ],
  "boundary_notes": "any notes about boundary line types, disputed areas, etc.",
  "scale_bar_visible": true,
  "grid_lines_visible": false,
  "overall_notes": "general observations about the map quality and content"
}

Return ONLY valid JSON. No explanation text before or after the JSON."""

    try:
        # Get image bytes
        image_bytes = None
        if job.source_document and job.source_document.file:
            with open(job.source_document.file.path, 'rb') as f:
                image_bytes = f.read()
        elif job.source_image:
            with open(job.source_image.path, 'rb') as f:
                image_bytes = f.read()

        if not image_bytes:
            raise ValueError('No image file found for this extraction job.')

        image_b64 = base64.b64encode(image_bytes).decode()

        svc = LLMService()
        raw = svc.vision_analyze(image_b64, EXTRACTION_PROMPT, model=job.vision_model)
        job.raw_response = raw

        # Parse JSON from the response
        parsed = _parse_json_from_text(raw)
        job.parsed_result = parsed

        # Build draft GeoJSON features from parcel descriptions
        # Since we have no coordinate data from scanned maps, we create point features
        # at the project's centroid area — user must georeference manually
        draft = []
        if parsed and 'parcels' in parsed:
            for i, parcel in enumerate(parsed['parcels']):
                draft.append({
                    'type': 'Feature',
                    'geometry': None,  # No coordinates — requires manual georeferencing
                    'properties': {
                        'survey_number': parcel.get('survey_number', f'parcel_{i+1}'),
                        'area_text': parcel.get('area_text', ''),
                        'shape': parcel.get('shape', ''),
                        'owner_text': parcel.get('owner_text', ''),
                        'adjacent_surveys': parcel.get('adjacent_surveys', []),
                        'notes': parcel.get('notes', ''),
                        'source': 'vision_extraction',
                        'needs_georeferencing': True,
                    },
                })
        job.draft_features = draft

        job.status = BoundaryExtractionJob.DONE
    except Exception as exc:
        job.status = BoundaryExtractionJob.FAILED
        job.error_log = str(exc)
    finally:
        job.completed_at = datetime.now(tz=dt_tz.utc)
        job.save(update_fields=['status', 'raw_response', 'parsed_result',
                                'draft_features', 'error_log', 'completed_at'])


def _parse_json_from_text(text: str) -> dict:
    """Extract JSON from a model response that may have surrounding text."""
    text = text.strip()
    # Try direct parse first
    try:
        return json.loads(text)
    except Exception:
        pass
    # Find first { and last }
    start = text.find('{')
    end   = text.rfind('}')
    if start != -1 and end != -1:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            pass
    return {}


# ── Training Dataset Export ───────────────────────────────────────────────────

@shared_task(bind=True, max_retries=0, name='ai_assistant.export_training_dataset')
def export_training_dataset(self, task_id: int):
    """
    Export project documents as instruction/response JSONL pairs suitable
    for Ollama / llama.cpp LoRA fine-tuning.
    Output file: /data/training/<project_id>_training.jsonl
    """
    import os
    from django.conf import settings as dj_settings
    from apps.ai_assistant.models import AITask
    from apps.ai_assistant.services import DGDE_SYSTEM_PROMPT

    task = AITask.objects.get(id=task_id)
    task.status = AITask.RUNNING
    task.save(update_fields=['status'])

    try:
        project_id = task.input_data['project_id']
        from apps.survey_projects.models import SurveyProject
        from apps.documents.models import Document

        project = SurveyProject.objects.get(id=project_id)
        docs = Document.objects.filter(project=project, ai_processed=True).exclude(ai_extracted_text='')

        records = []
        for doc in docs:
            text = (doc.ai_extracted_text or '')[:3000]
            if not text.strip():
                continue
            records.append({
                'system': DGDE_SYSTEM_PROMPT,
                'instruction': f"Summarise this survey document from project {project.project_number}: {doc.title}",
                'response': doc.ai_summary or text[:500],
            })
            records.append({
                'system': DGDE_SYSTEM_PROMPT,
                'instruction': f"What key survey information is in this document?\n\n{text[:2000]}",
                'response': doc.ai_summary or 'No summary available.',
            })

        output_dir = os.path.join(dj_settings.MEDIA_ROOT, 'training')
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f'{project_id}_training.jsonl')

        with open(output_path, 'w') as f:
            for rec in records:
                f.write(json.dumps(rec) + '\n')

        task.status = AITask.DONE
        task.result = {
            'record_count': len(records),
            'output_file': output_path,
            'note': 'Use this JSONL with `ollama create` or llama.cpp fine-tuning scripts.',
        }
    except Exception as exc:
        task.status = AITask.FAILED
        task.error_message = str(exc)
    finally:
        task.completed_at = timezone.now()
        task.save(update_fields=['status', 'result', 'error_message', 'completed_at'])
