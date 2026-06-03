import json
import os
import tempfile
import zipfile
import subprocess
import numpy as np

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
    Send a map image to a vision LLM and parse the response into draft GeoJSON features.

    Two modes:
    • Scanned map  → geometry=null, needs manual georeferencing
    • GeoTiff      → real WGS-84 polygon coordinates derived from the image extent
    """
    import base64
    import subprocess
    from datetime import timezone as dt_tz
    from datetime import datetime

    from apps.ai_assistant.models import BoundaryExtractionJob
    from apps.ai_assistant.services import LLMService

    job = BoundaryExtractionJob.objects.select_related(
        'source_document', 'project', 'source_geotiff'
    ).get(id=job_id)
    job.status = BoundaryExtractionJob.RUNNING
    job.save(update_fields=['status'])

    # ── Scanned map prompt ────────────────────────────────────────────────────
    SCAN_PROMPT = """You are analysing a scanned paper land survey / cadastral map from India
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

    tmp_png = None
    try:
        svc = LLMService()

        # ── Mode A: GeoTiff source ────────────────────────────────────────────
        if job.source_geotiff:
            from django.conf import settings as dj_settings

            geotiff = job.source_geotiff
            # Prefer the raw upload file for rendering — COG tiles may fail
            # with plain gdal_translate; the raw GeoTiff is always safe.
            # Fall back to COG only when the raw file is missing.
            raw_field = geotiff.file
            cog_field = geotiff.cog_file
            raw_path  = os.path.join(dj_settings.MEDIA_ROOT, raw_field.name) if raw_field else None
            cog_path  = os.path.join(dj_settings.MEDIA_ROOT, cog_field.name) if cog_field else None

            # Pick best source: prefer raw file (exists + non-empty), else COG
            if raw_path and os.path.exists(raw_path) and os.path.getsize(raw_path) > 0:
                src_path = raw_path
            elif cog_path and os.path.exists(cog_path):
                src_path = cog_path
            else:
                raise FileNotFoundError(f'No accessible GeoTiff file for layer {geotiff.id}')

            # ── Get geographic extent via gdalinfo ────────────────────────────
            info_out = subprocess.run(
                ['gdalinfo', '-json', src_path],
                check=True, capture_output=True, text=True,
            ).stdout
            info = json.loads(info_out)

            corners = info.get('cornerCoordinates', {})
            ul = corners.get('upperLeft',  [0, 90])
            lr = corners.get('lowerRight', [1, 0])
            west, north = float(ul[0]), float(ul[1])
            east, south = float(lr[0]), float(lr[1])

            # ── Render to PNG for vision model (max 1024 px wide) ─────────────
            # Use gdalwarp (handles COG, tiled, compressed formats better than
            # gdal_translate -scale alone). Output to a temp file.
            import tempfile as _tempfile
            tmp_png_fd, tmp_png = _tempfile.mkstemp(suffix='_vis.png')
            os.close(tmp_png_fd)

            try:
                subprocess.run(
                    [
                        'gdalwarp',
                        '-of', 'PNG',
                        '-ts', '1024', '0',      # target size: 1024 px wide, proportional height
                        '-r', 'bilinear',
                        '-co', 'WORLDFILE=NO',
                        src_path, tmp_png,
                    ],
                    check=True, capture_output=True,
                )
            except subprocess.CalledProcessError:
                # gdalwarp fallback: use gdal_translate with explicit scale
                subprocess.run(
                    [
                        'gdal_translate', src_path, tmp_png,
                        '-of', 'PNG',
                        '-outsize', '1024', '0',
                        '-scale',
                        '-ot', 'Byte',
                    ],
                    check=True, capture_output=True,
                )
            with open(tmp_png, 'rb') as fh:
                image_b64 = base64.b64encode(fh.read()).decode()

            geotiff_prompt = f"""You are analysing a georeferenced satellite/drone image for DGDE Defence Estates land survey.

Geographic bounds of this image (WGS84 decimal degrees):
  Top-left corner:     {north:.6f}°N, {west:.6f}°E
  Bottom-right corner: {south:.6f}°N, {east:.6f}°E

Detect and trace ALL of the following feature types:
1. OUTER BOUNDARY — the outermost perimeter of the entire surveyed area.
2. INNER PARCELS — each individual sub-parcel, plot, or land division visible inside the boundary (trace each one separately).
3. STRUCTURES — buildings, sheds, tanks, any man-made structures.
4. ROADS & PATHS — roads, tracks, pathways.
5. WATER BODIES — rivers, canals, ponds, drainage.
6. VEGETATION — forest patches, agricultural fields, scrubland.

For EACH feature trace its boundary polygon using NORMALISED image coordinates:
  x: 0.0 = left edge → 1.0 = right edge
  y: 0.0 = top edge  → 1.0 = bottom edge
  Minimum 4 vertices. Close each polygon by repeating the first vertex last.

Return ONLY valid JSON (no text before or after the JSON block):
{{
  "features": [
    {{
      "type": "outer_boundary|inner_parcel|building|road|water|vegetation|structure|fence|other",
      "label": "descriptive name (e.g. 'Survey Area Boundary', 'Parcel A-1', 'Khasra 123', 'Main Road')",
      "polygon": [[x1,y1],[x2,y2],[x3,y3],[x4,y4],[x1,y1]],
      "is_outer": false,
      "confidence": "high|medium|low",
      "notes": "any observations about this feature"
    }}
  ],
  "image_quality": "clear|partially_obscured|cloudy|unclear",
  "overall_description": "brief scene description"
}}\n\nIMPORTANT: include both the outer boundary AND every inner parcel as separate feature entries."""

            raw = svc.vision_analyze(image_b64, geotiff_prompt, model=job.vision_model)
            job.raw_response = raw

            parsed = _parse_json_from_text(raw)
            raw_features = parsed.get('features', [])
            job.parsed_result = {
                'source': 'geotiff',
                'bounds': {'west': west, 'south': south, 'east': east, 'north': north},
                'image_quality': parsed.get('image_quality', ''),
                'overall_description': parsed.get('overall_description', ''),
                'model_feature_count': len(raw_features),
            }

            # Convert normalised pixel coords → WGS-84 lon/lat
            def _norm_to_lonlat(x_norm: float, y_norm: float):
                # Clamp to [0,1] — model may return slightly out-of-range values
                x_norm = max(0.0, min(1.0, float(x_norm)))
                y_norm = max(0.0, min(1.0, float(y_norm)))
                return [
                    round(west  + x_norm * (east  - west),  8),
                    round(north - y_norm * (north - south),  8),  # y=0 → north
                ]

            draft = []
            skipped_reasons = []
            for i, feat in enumerate(raw_features):
                poly_norm = feat.get('polygon', [])
                if not poly_norm:
                    skipped_reasons.append(f'feature {i}: no polygon key')
                    continue
                # Accept both [[x,y],...] and [[x,y,z],...] point formats
                try:
                    pts = [[float(p[0]), float(p[1])] for p in poly_norm]
                except (TypeError, IndexError, ValueError) as e:
                    skipped_reasons.append(f'feature {i}: bad coords ({e})')
                    continue
                if len(pts) < 3:
                    skipped_reasons.append(f'feature {i}: only {len(pts)} vertices')
                    continue
                ring = [_norm_to_lonlat(pt[0], pt[1]) for pt in pts]
                # Ensure the ring is closed
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                draft.append({
                    'type': 'Feature',
                    'geometry': {'type': 'Polygon', 'coordinates': [ring]},
                    'properties': {
                        'feature_type': feat.get('type', 'unknown'),
                        'label':        feat.get('label', f'Feature {i+1}'),
                        'is_outer':     bool(feat.get('is_outer', False) or feat.get('type') == 'outer_boundary'),
                        'confidence':   feat.get('confidence', 'medium'),
                        'notes':        feat.get('notes', ''),
                        'source':       'geotiff_vision',
                        'has_coordinates': True,
                    },
                })

            job.parsed_result['polygon_count'] = len(draft)
            if skipped_reasons:
                job.parsed_result['skipped_features'] = skipped_reasons

        # ── Mode B: Scanned map ───────────────────────────────────────────────
        else:
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
            raw    = svc.vision_analyze(image_b64, SCAN_PROMPT, model=job.vision_model)
            job.raw_response = raw
            parsed = _parse_json_from_text(raw)
            job.parsed_result = parsed

            draft = []
            if parsed and 'parcels' in parsed:
                for i, parcel in enumerate(parsed['parcels']):
                    draft.append({
                        'type': 'Feature',
                        'geometry': None,
                        'properties': {
                            'survey_number':   parcel.get('survey_number', f'parcel_{i+1}'),
                            'area_text':       parcel.get('area_text', ''),
                            'shape':           parcel.get('shape', ''),
                            'owner_text':      parcel.get('owner_text', ''),
                            'adjacent_surveys':parcel.get('adjacent_surveys', []),
                            'notes':           parcel.get('notes', ''),
                            'source':          'vision_extraction',
                            'has_coordinates': False,
                        },
                    })

        job.draft_features = draft
        job.status = BoundaryExtractionJob.DONE

    except Exception as exc:
        job.status    = BoundaryExtractionJob.FAILED
        job.error_log = str(exc)
    finally:
        if tmp_png and os.path.exists(tmp_png):
            try:
                os.unlink(tmp_png)
            except Exception:
                pass
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


# ── Classical GIS Polygon Extraction ─────────────────────────────────────────

# Lazily-instantiated PaddleOCR singleton (heavy to construct; reused across
# polygons). `False` means OCR is unavailable in this environment.
_PADDLE_OCR = None


def _get_paddle_ocr():
    global _PADDLE_OCR
    if _PADDLE_OCR is not None:
        return _PADDLE_OCR
    try:
        from paddleocr import PaddleOCR
        _PADDLE_OCR = PaddleOCR(use_angle_cls=True, lang='en', show_log=False)
    except Exception:
        _PADDLE_OCR = False
    return _PADDLE_OCR


def _poly_lonlat_bounds(geojson_geom):
    """Return (min_lon, min_lat, max_lon, max_lat) for a GeoJSON polygon geometry."""
    pts = []

    def _walk(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            pts.append(c)
        elif isinstance(c, (list, tuple)):
            for x in c:
                _walk(x)

    _walk((geojson_geom or {}).get('coordinates'))
    if not pts:
        return None
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    return min(lons), min(lats), max(lons), max(lats)


def _ocr_survey_number(gray_small, geojson_geom, west, north, pix_w_s, pix_h_s):
    """
    Best-effort survey-number OCR for a single polygon. Crops the polygon's
    bounding box from the (downsampled) grayscale raster and reads the most
    confident number-like token. Returns (text, confidence); ('', 0.0) on any
    failure or when OCR is unavailable — the caller leaves the attribute blank.
    """
    import re
    import numpy as np
    try:
        ocr = _get_paddle_ocr()
        if not ocr:
            return '', 0.0
        b = _poly_lonlat_bounds(geojson_geom)
        if not b:
            return '', 0.0
        min_lon, min_lat, max_lon, max_lat = b
        h, w = gray_small.shape[:2]
        # pix_h_s is negative (north→south), so max_lat maps to the smaller y.
        x0 = int((min_lon - west) / pix_w_s)
        x1 = int((max_lon - west) / pix_w_s)
        y0 = int((max_lat - north) / pix_h_s)
        y1 = int((min_lat - north) / pix_h_s)
        x0, x1 = sorted((max(0, min(x0, w - 1)), max(0, min(x1, w - 1))))
        y0, y1 = sorted((max(0, min(y0, h - 1)), max(0, min(y1, h - 1))))
        if (x1 - x0) < 6 or (y1 - y0) < 6:
            return '', 0.0
        crop = gray_small[y0:y1, x0:x1]
        crop_rgb = np.stack([crop] * 3, axis=-1) if crop.ndim == 2 else crop
        result = ocr.ocr(crop_rgb, cls=True)
        if not result or not result[0]:
            return '', 0.0
        best_text, best_conf = '', 0.0
        for line in result[0]:
            try:
                txt, conf = line[1][0], float(line[1][1])
            except Exception:
                continue
            if conf > best_conf:
                best_text, best_conf = txt, conf
        # Prefer a survey-number-like token (digits with optional /-letter parts).
        m = re.search(r'[0-9]+(?:[/\-][0-9A-Za-z]+)*', best_text or '')
        token = m.group(0) if m else (best_text or '').strip()
        return token, round(best_conf, 3)
    except Exception:
        return '', 0.0


@shared_task(bind=True, max_retries=0, name='ai_assistant.extract_polygons_classical')
def extract_polygons_classical(self, job_id: int):
    """
    Industry-standard classical GIS pipeline for automated polygon extraction.

    GeoTIFF → grayscale → Gaussian smooth → edge detection (Sobel)
           → Otsu threshold → morphological gap closing (dilation)
           → connected component labeling → area filtering
           → GDAL Polygonize → WGS-84 GeoJSON draft features

    No vision LLM required. Uses the same spatial primitives as QGIS,
    ArcGIS Pro and Orfeo Toolbox.

    Parameters stored in BoundaryExtractionJob.raw_response (JSON string):
      edge_sensitivity   : float 0–1, higher = more edges detected (default 0.3)
      min_area_m2        : float, minimum polygon area in m² (default 500)
      dilation_px        : int, morphological dilation radius in pixels (default 3)
      simplify_tolerance : float, Douglas-Peucker tolerance in degrees (default 0.00005)
    """
    import json as _json
    import subprocess
    import tempfile
    import numpy as np
    from datetime import datetime, timezone as dt_tz
    from PIL import Image, ImageFilter
    from apps.ai_assistant.models import BoundaryExtractionJob

    job = BoundaryExtractionJob.objects.select_related(
        'project', 'source_geotiff'
    ).get(id=job_id)
    job.status = BoundaryExtractionJob.RUNNING
    job.save(update_fields=['status'])

    # Read params stored by the view as JSON in raw_response
    try:
        params = _json.loads(job.raw_response or '{}')
    except Exception:
        params = {}

    edge_sensitivity   = float(params.get('edge_sensitivity',   0.3))
    min_area_m2        = float(params.get('min_area_m2',        500.0))
    dilation_px        = int(params.get('dilation_px',          3))
    simplify_tol       = float(params.get('simplify_tolerance', 0.00005))
    # Best-effort survey-number OCR (default on). Bounded to keep the task fast;
    # polygons beyond the cap (or where nothing is read) get a blank survey_number.
    ocr_enabled        = str(params.get('ocr_survey_numbers', True)).lower() not in ('false', '0', 'none')
    OCR_MAX_POLYGONS   = 500

    tmp_files = []

    try:
        from osgeo import gdal, ogr, osr

        # ── Locate source file ────────────────────────────────────────────────
        from django.conf import settings as _s
        geotiff = job.source_geotiff
        raw_path = os.path.join(_s.MEDIA_ROOT, geotiff.file.name) if geotiff.file else None
        cog_path = os.path.join(_s.MEDIA_ROOT, geotiff.cog_file.name) if geotiff.cog_file else None

        if raw_path and os.path.exists(raw_path) and os.path.getsize(raw_path) > 0:
            src_path = raw_path
        elif cog_path and os.path.exists(cog_path):
            src_path = cog_path
        else:
            raise FileNotFoundError('No accessible GeoTiff file for this layer.')

        # ── Reproject to WGS-84 ────────────────────────────────────────────────
        wgs84_fd, wgs84_path = tempfile.mkstemp(suffix='_wgs84.tif')
        os.close(wgs84_fd)
        tmp_files.append(wgs84_path)

        ret = subprocess.run(
            ['gdalwarp', '-t_srs', 'EPSG:4326', '-of', 'GTiff',
             '-r', 'bilinear', '-overwrite', src_path, wgs84_path],
            capture_output=True,
        )
        if ret.returncode != 0:
            # Already WGS-84 or gdalwarp failed — use original
            wgs84_path = src_path
            tmp_files.pop()

        # ── Open with GDAL + read spatial metadata ─────────────────────────────
        ds = gdal.Open(wgs84_path)
        if ds is None:
            raise RuntimeError(f'GDAL cannot open {wgs84_path}')

        gt     = ds.GetGeoTransform()   # (west, pix_w, 0, north, 0, pix_h)
        proj   = ds.GetProjection()
        orig_w = ds.RasterXSize
        orig_h = ds.RasterYSize
        west   = gt[0]
        north  = gt[3]
        pix_w  = gt[1]   # degrees per pixel, positive
        pix_h  = gt[5]   # degrees per pixel, negative
        east   = west  + orig_w * pix_w
        south  = north + orig_h * pix_h   # north + neg * height

        # ── Read bands → grayscale ─────────────────────────────────────────────
        nb = ds.RasterCount
        if nb >= 3:
            r = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
            g = ds.GetRasterBand(2).ReadAsArray().astype(np.float32)
            b = ds.GetRasterBand(3).ReadAsArray().astype(np.float32)
            gray_arr = (0.299 * r + 0.587 * g + 0.114 * b).astype(np.uint8)
        else:
            data = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
            lo, hi = data.min(), data.max()
            if hi > lo:
                gray_arr = ((data - lo) / (hi - lo) * 255).astype(np.uint8)
            else:
                gray_arr = np.zeros_like(data, dtype=np.uint8)
        ds = None  # close

        # ── Downsample large images (keep ≤ 4096 px on longest side) ──────────
        MAX_PX = 4096
        scale  = min(MAX_PX / orig_w, MAX_PX / orig_h, 1.0)
        proc_w = max(1, int(orig_w * scale))
        proc_h = max(1, int(orig_h * scale))

        img_pil = Image.fromarray(gray_arr).resize((proc_w, proc_h), Image.LANCZOS)
        gray_small = np.array(img_pil)

        # Adjusted pixel sizes for the downsampled image
        pix_w_s = (east - west)  / proc_w
        pix_h_s = (south - north) / proc_h   # negative

        # ── Step 2: Gaussian smooth → reduce noise ─────────────────────────────
        img_smooth = img_pil.filter(ImageFilter.GaussianBlur(radius=2))

        # ── Step 3: Sobel edge detection via PIL ───────────────────────────────
        img_edges = img_smooth.filter(ImageFilter.FIND_EDGES)
        edge_arr  = np.array(img_edges, dtype=np.float32)

        # ── Step 4: Otsu threshold → binary edge mask ──────────────────────────
        # Compute Otsu automatically, then scale by sensitivity
        hist = np.bincount(edge_arr.astype(np.uint8).flatten(), minlength=256).astype(np.float64)
        total = edge_arr.size
        sum_total = np.dot(np.arange(256), hist)
        sum_bg = w_bg = 0.0
        best_var = -1.0
        otsu_t = 128
        for i in range(256):
            w_bg += hist[i]
            if w_bg == 0 or w_bg == total:
                continue
            w_fg = total - w_bg
            sum_bg += i * hist[i]
            mu_bg = sum_bg / w_bg
            mu_fg = (sum_total - sum_bg) / w_fg
            var = w_bg * w_fg * (mu_bg - mu_fg) ** 2
            if var > best_var:
                best_var = var
                otsu_t = i

        # Sensitivity: lower value = detect more (fainter) edges
        threshold = max(1, int(otsu_t * (1.0 - edge_sensitivity)))
        binary_edges = (edge_arr > threshold).astype(np.uint8)

        # ── Step 5: Morphological dilation → close gaps in boundary lines ──────
        # Dilation radius in pixels; repeat filter for larger radii
        dil_img = Image.fromarray(binary_edges * 255)
        kernel  = max(3, dilation_px * 2 + 1)
        repeats = max(1, dilation_px // 2 + 1)
        for _ in range(repeats):
            dil_img = dil_img.filter(ImageFilter.MaxFilter(kernel))
        dilated = np.array(dil_img) > 128

        # ── Step 6: Invert → enclosed regions are filled pixels ────────────────
        regions = (~dilated).astype(np.uint8)

        # ── Step 7: Connected component labeling ──────────────────────────────
        try:
            from scipy.ndimage import label as scipy_label
            labeled, n_comp = scipy_label(regions)
        except ImportError:
            labeled, n_comp = _bfs_label(regions)

        # ── Step 8: Area filter in pixel space → m² conversion ─────────────────
        # 1 degree ≈ 111 320 m at equator; use pix_w_s (lon) for coarse filter
        deg_per_pix = abs(pix_w_s)
        m_per_pix   = deg_per_pix * 111_320
        m2_per_pixel = m_per_pix ** 2
        min_px  = max(4, int(min_area_m2 / m2_per_pixel))

        # Zero out labels that are too small (they'll become nodata)
        counts = np.bincount(labeled.flatten())   # index = label id, value = pixel count
        for lid in range(1, n_comp + 1):
            if lid < len(counts) and counts[lid] < min_px:
                labeled[labeled == lid] = 0

        # ── Step 9: Write labeled raster as GeoTiff with spatial reference ──────
        lbl_fd, lbl_path = tempfile.mkstemp(suffix='_labeled.tif')
        os.close(lbl_fd)
        tmp_files.append(lbl_path)

        drv    = gdal.GetDriverByName('GTiff')
        out_ds = drv.Create(lbl_path, proc_w, proc_h, 1, gdal.GDT_Int32)
        out_ds.SetGeoTransform((west, pix_w_s, 0, north, 0, pix_h_s))
        out_ds.SetProjection(proj)
        band = out_ds.GetRasterBand(1)
        band.WriteArray(labeled.astype(np.int32))
        band.SetNoDataValue(0)
        out_ds.FlushCache()
        out_ds = None

        # ── Step 10: GDAL Polygonize ───────────────────────────────────────────
        gjson_fd, gjson_path = tempfile.mkstemp(suffix='_polygons.geojson')
        os.close(gjson_fd)
        tmp_files.append(gjson_path)

        src_ds  = gdal.Open(lbl_path)
        src_bnd = src_ds.GetRasterBand(1)

        mem_drv = ogr.GetDriverByName('Memory')
        mem_ds  = mem_drv.CreateDataSource('mem')
        srs_wgs = osr.SpatialReference()
        srs_wgs.ImportFromEPSG(4326)
        srs_wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        mem_lyr = mem_ds.CreateLayer('poly', srs_wgs, ogr.wkbPolygon)
        fld_def = ogr.FieldDefn('label_id', ogr.OFTInteger)
        mem_lyr.CreateField(fld_def)

        gdal.Polygonize(src_bnd, None, mem_lyr, 0, [], callback=None)
        src_ds = None

        # ── Step 11: Optional geometry simplification + build draft features ────
        draft = []
        mem_lyr.ResetReading()
        feat_ogr = mem_lyr.GetNextFeature()
        feat_idx = 0
        while feat_ogr:
            label_id = feat_ogr.GetField('label_id')
            if label_id == 0:
                feat_ogr = mem_lyr.GetNextFeature()
                continue

            geom = feat_ogr.GetGeometryRef()
            if geom is None:
                feat_ogr = mem_lyr.GetNextFeature()
                continue

            # Simplify (Douglas-Peucker)
            if simplify_tol > 0:
                geom = geom.Simplify(simplify_tol)

            if geom is None or geom.IsEmpty():
                feat_ogr = mem_lyr.GetNextFeature()
                continue

            geojson_geom = _json.loads(geom.ExportToJson())
            area_deg2 = geom.GetArea()
            area_m2 = area_deg2 * (111_320 ** 2)

            # Best-effort survey number from OCR (blank when not readable).
            survey_number, ocr_conf = '', 0.0
            if ocr_enabled and feat_idx < OCR_MAX_POLYGONS:
                survey_number, ocr_conf = _ocr_survey_number(
                    gray_small, geojson_geom, west, north, pix_w_s, pix_h_s,
                )

            draft.append({
                'type': 'Feature',
                'geometry': geojson_geom,
                'properties': {
                    'feature_type': 'parcel',
                    'label':        f'Region {label_id}',
                    'label_id':     label_id,
                    'area_m2':      round(area_m2, 1),
                    'confidence':   'high',
                    'survey_number':  survey_number,
                    'ocr_confidence': ocr_conf,
                    'source':       'classical_gis',
                    'has_coordinates': True,
                },
            })
            feat_idx += 1
            feat_ogr = mem_lyr.GetNextFeature()

        mem_ds = None

        job.draft_features = draft
        job.parsed_result  = {
            'source':           'classical_gis',
            'pipeline':         'sobel→otsu→dilate→label→polygonize',
            'params':           params,
            'bounds':           {'west': west, 'south': south, 'east': east, 'north': north},
            'image_size':       [orig_w, orig_h],
            'processed_size':   [proc_w, proc_h],
            'otsu_threshold':   otsu_t,
            'applied_threshold': threshold,
            'n_components':     int(n_comp),
            'polygon_count':    len(draft),
            'min_area_m2':      min_area_m2,
        }
        job.raw_response = ''   # clear params – stored in parsed_result now
        job.status = BoundaryExtractionJob.DONE

    except Exception as exc:
        import traceback
        job.status    = BoundaryExtractionJob.FAILED
        job.error_log = f'{exc}\n{traceback.format_exc()[-1500:]}'

    finally:
        for f in tmp_files:
            try:
                if f and os.path.exists(f):
                    os.unlink(f)
            except Exception:
                pass
        from datetime import datetime, timezone as dt_tz
        job.completed_at = datetime.now(tz=dt_tz.utc)
        job.save(update_fields=[
            'status', 'draft_features', 'parsed_result',
            'raw_response', 'error_log', 'completed_at',
        ])


def _bfs_label(binary: np.ndarray):
    """
    Pure-Python BFS connected component labeling (fallback when scipy is absent).
    Returns (labeled_array, n_labels).
    """
    import numpy as np
    from collections import deque

    h, w = binary.shape
    labeled = np.zeros((h, w), dtype=np.int32)
    label_id = 0

    for row in range(h):
        for col in range(w):
            if binary[row, col] == 0 or labeled[row, col] != 0:
                continue
            label_id += 1
            q = deque()
            q.append((row, col))
            labeled[row, col] = label_id
            while q:
                r, c = q.popleft()
                for dr, dc in ((1,0),(-1,0),(0,1),(0,-1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < h and 0 <= nc < w and binary[nr, nc] and labeled[nr, nc] == 0:
                        labeled[nr, nc] = label_id
                        q.append((nr, nc))

    return labeled, label_id


@shared_task(bind=True, max_retries=0, name='ai_assistant.extract_polygons_ai_pipeline')
def extract_polygons_ai_pipeline(self, job_id: int):
    """
    Advanced 10-stage AI Vision pipeline task for georeferenced GeoTIFFs.
    """
    import os
    from datetime import datetime, timezone as dt_tz
    from apps.ai_assistant.models import BoundaryExtractionJob
    from apps.ai_assistant.pipeline import AIVisionPipeline
    
    job = BoundaryExtractionJob.objects.select_related(
        'project', 'source_geotiff'
    ).get(id=job_id)
    job.status = BoundaryExtractionJob.RUNNING
    job.save(update_fields=['status'])
    
    try:
        import json as _json
        try:
            params = _json.loads(job.raw_response or '{}')
        except Exception:
            params = {}
            
        tile_size = int(params.get('tile_size', 1024))
        min_area_m2 = float(params.get('min_area_m2', 500.0))
        simplify_tolerance = float(params.get('simplify_tolerance', 0.00005))
        edge_sensitivity = float(params.get('edge_sensitivity', 0.3))
        dilation_px = int(params.get('dilation_px', 3))
        
        from django.conf import settings as _s
        geotiff = job.source_geotiff
        if not geotiff:
            raise ValueError("No GeoTIFF layer associated with this pipeline job.")
            
        raw_path = os.path.join(_s.MEDIA_ROOT, geotiff.file.name) if geotiff.file else None
        cog_path = os.path.join(_s.MEDIA_ROOT, geotiff.cog_file.name) if geotiff.cog_file else None
        
        if raw_path and os.path.exists(raw_path) and os.path.getsize(raw_path) > 0:
            src_path = raw_path
        elif cog_path and os.path.exists(cog_path):
            src_path = cog_path
        else:
            raise FileNotFoundError('No accessible GeoTiff file for this layer.')
            
        # Instantiate and run pipeline
        pipeline = AIVisionPipeline(
            geotiff_path=src_path,
            project=job.project,
            vision_model=job.vision_model,
            tile_size=tile_size,
            min_area_m2=min_area_m2,
            simplify_tolerance=simplify_tolerance,
            edge_sensitivity=edge_sensitivity,
            dilation_px=dilation_px
        )
        
        draft, parsed_meta = pipeline.run()
        
        job.draft_features = draft
        job.parsed_result = parsed_meta
        job.raw_response = parsed_meta.get('qa_review', '')
        job.status = BoundaryExtractionJob.DONE
        
    except Exception as exc:
        import traceback
        job.status = BoundaryExtractionJob.FAILED
        job.error_log = f'{exc}\n{traceback.format_exc()[-1500:]}'
        
    finally:
        job.completed_at = datetime.now(tz=dt_tz.utc)
        job.save(update_fields=[
            'status', 'draft_features', 'parsed_result',
            'raw_response', 'error_log', 'completed_at',
        ])

