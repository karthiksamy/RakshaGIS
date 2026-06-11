import json
import os
import tempfile

import httpx
from django.conf import settings
from django.http import FileResponse, Http404, HttpResponse
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response

from .models import ChatSession, ChatMessage, AITask, LLMConfig, BoundaryExtractionJob, DocumentChunk
from .serializers import (
    ChatSessionSerializer, ChatMessageSerializer,
    ChatInputSerializer, AITaskSerializer, LLMConfigSerializer,
)
from .services import LLMService as OllamaService  # alias kept for internal use

SENSITIVE_FIELD_PATTERNS = [
    'aadhar', 'aadhaar', 'pan', 'mobile', 'phone', 'email', 'address',
    'name', 'owner', 'proprietor', 'occupant', 'ssn', 'dob', 'birth',
    'passport', 'driving', 'licence', 'license', 'ration', 'voter',
]
ALLOWED_GIS_EXTENSIONS = {'.geojson', '.json', '.kml', '.gpkg', '.zip', '.csv'}


def _detect_sensitive_fields(file_path: str, ext: str) -> list[str]:
    found = []
    try:
        if ext in ('.geojson', '.json'):
            with open(file_path, encoding='utf-8', errors='ignore') as f:
                data = json.load(f)
            features = data.get('features', [])
            if features:
                keys = list(features[0].get('properties', {}).keys())
                found = [k for k in keys if any(p in k.lower() for p in SENSITIVE_FIELD_PATTERNS)]
        elif ext in ('.gpkg', '.zip', '.shp', '.kml'):
            try:
                import geopandas as gpd
                import zipfile as _zf
                read_path = file_path
                if ext == '.zip':
                    td = tempfile.mkdtemp()
                    with _zf.ZipFile(file_path) as z:
                        z.extractall(td)
                    shps = [os.path.join(td, f) for f in os.listdir(td) if f.endswith('.shp')]
                    read_path = shps[0] if shps else file_path
                gdf = gpd.read_file(read_path)
                cols = [c for c in gdf.columns if c != 'geometry']
                found = [c for c in cols if any(p in c.lower() for p in SENSITIVE_FIELD_PATTERNS)]
            except Exception:
                pass
        elif ext == '.csv':
            import pandas as pd
            df = pd.read_csv(file_path, nrows=1)
            found = [c for c in df.columns if any(p in c.lower() for p in SENSITIVE_FIELD_PATTERNS)]
    except Exception:
        pass
    return found


class ChatSessionViewSet(viewsets.ModelViewSet):
    serializer_class = ChatSessionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return ChatSession.objects.filter(user=self.request.user).prefetch_related('messages')

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    @action(detail=True, methods=['post'])
    def chat(self, request, pk=None):
        session = self.get_object()
        serializer = ChatInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user_message = serializer.validated_data['message']
        project_id   = request.data.get('project_id')  # optional: triggers RAG

        # Org-level retrieval scope: DGDE → all, PDDE → subtree, DEO/CEO/ADEO →
        # own org + explicit grants. Never let the AI read a project outside
        # the requesting user's access level.
        if project_id:
            from apps.survey_projects.access import ai_can_access_project
            if not ai_can_access_project(request.user, project_id):
                return Response(
                    {'detail': 'You do not have access to this project’s data.'},
                    status=status.HTTP_403_FORBIDDEN,
                )

        ChatMessage.objects.create(session=session, role=ChatMessage.USER, content=user_message)

        service = OllamaService()
        if not service.is_available():
            return Response(
                {
                    'detail': (
                        f'Ollama is not reachable at {service.base_url}. '
                        'Ensure Ollama is running (ollama serve) and the model is pulled '
                        f'(ollama pull {service.model}).'
                    )
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        rag_sources = []
        try:
            if project_id:
                # RAG mode: retrieve relevant chunks + inject as context
                has_chunks = DocumentChunk.objects.filter(
                    project_id=project_id
                ).exclude(embedding=[]).exists()
                if has_chunks:
                    reply, rag_sources = service.answer_with_rag(user_message, int(project_id))
                else:
                    # No embeddings yet — fall back to plain chat
                    history = list(session.messages.values('role', 'content').order_by('timestamp'))
                    messages = [{'role': m['role'].lower(), 'content': m['content']} for m in history]
                    reply = service.chat(messages)
            else:
                history = list(session.messages.values('role', 'content').order_by('timestamp'))
                messages = [{'role': m['role'].lower(), 'content': m['content']} for m in history]
                reply = service.chat(messages)
        except Exception as exc:
            return Response(
                {'detail': f'AI inference failed ({service.base_url}, model={service.model}): {exc}'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        assistant_msg = ChatMessage.objects.create(session=session, role=ChatMessage.ASSISTANT, content=reply)
        session.save(update_fields=['updated_at'])

        data = ChatMessageSerializer(assistant_msg).data
        data['rag_sources'] = rag_sources
        data['rag_active']  = bool(rag_sources)
        return Response(data)


class AITaskViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AITaskSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        qs = AITask.objects.select_related('requested_by')
        if user.role == 'SUPERADMIN':
            return qs
        # Office admins see their own office subtree's tasks; everyone else
        # only their own. Tasks must never leak across office boundaries
        # (results may contain report text / data summaries).
        org = getattr(user, 'organisation', None)
        if org and user.role in ('PDDE_VIEWER', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'):
            return qs.filter(requested_by__organisation_id__in=org.get_subtree_ids())
        return qs.filter(requested_by=user)

    @action(detail=False, methods=['post'], url_path='generate-report/(?P<project_pk>[^/.]+)')
    def generate_report(self, request, project_pk=None):
        from apps.ai_assistant.tasks import generate_project_report
        from apps.survey_projects.access import ai_can_access_project

        if not ai_can_access_project(request.user, project_pk):
            return Response({'detail': 'You do not have access to this project.'},
                            status=status.HTTP_403_FORBIDDEN)

        task = AITask.objects.create(
            task_type=AITask.REPORT_GENERATION,
            requested_by=request.user,
            input_data={'project_id': project_pk},
        )
        generate_project_report.delay(task.id)
        return Response({'task_id': task.id, 'detail': 'Report generation queued.'})

    @action(detail=False, methods=['get'])
    def health(self, request):
        service = OllamaService()
        available = service.is_available()
        return Response({
            'ollama_available': available,
            'model': service.model,
            'base_url': service.base_url,
        })

    @action(detail=True, methods=['get'], url_path='download-report')
    def download_report(self, request, pk=None):
        """Download the generated report text file for a DONE report-generation task."""
        task = self.get_object()
        if task.task_type != AITask.REPORT_GENERATION:
            return Response({'detail': 'Not a report task.'}, status=status.HTTP_400_BAD_REQUEST)
        if task.status != AITask.DONE:
            return Response({'detail': f'Report not ready. Status: {task.status}'}, status=status.HTTP_409_CONFLICT)

        rel_path = (task.result or {}).get('file_rel_path')
        if not rel_path:
            return Response({'detail': 'Report file path not recorded.'}, status=status.HTTP_404_NOT_FOUND)

        abs_path = os.path.join(settings.MEDIA_ROOT, rel_path)
        if not os.path.exists(abs_path):
            raise Http404

        fname = os.path.basename(abs_path)
        with open(abs_path, 'rb') as fh:
            content = fh.read()

        # Apply provenance watermark + Trust Registry entry to the generated report.
        try:
            from apps.core.watermark import embed_watermark
            metadata = {
                "title": fname,
                "export_format": "txt",
                "generated_by": request.user.username,
            }
            content = embed_watermark(content, fname, 'text/plain', metadata)
        except Exception:
            pass

        resp = HttpResponse(content, content_type='text/plain; charset=utf-8')
        resp['Content-Disposition'] = f'attachment; filename="{fname}"'
        return resp

    @action(
        detail=False, methods=['post'], url_path='index-gis/preview',
        parser_classes=[MultiPartParser, FormParser],
    )
    def index_gis_preview(self, request):
        """
        Step 1: Upload a GIS file, scan for sensitive fields, return metadata.
        The file is saved to a temp location keyed by upload_id.
        """
        file = request.FILES.get('file')
        if not file:
            return Response({'detail': 'No file provided.'}, status=status.HTTP_400_BAD_REQUEST)

        ext = os.path.splitext(file.name)[1].lower()
        if ext not in ALLOWED_GIS_EXTENSIONS:
            return Response(
                {'detail': f'File type {ext} not supported. Allowed: {", ".join(sorted(ALLOWED_GIS_EXTENSIONS))}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        upload_dir = os.path.join(settings.MEDIA_ROOT, 'gis_uploads')
        os.makedirs(upload_dir, exist_ok=True)

        import uuid
        upload_id = str(uuid.uuid4())
        save_path = os.path.join(upload_dir, f"{upload_id}{ext}")
        with open(save_path, 'wb') as fout:
            for chunk in file.chunks():
                fout.write(chunk)

        sensitive_fields = _detect_sensitive_fields(save_path, ext)

        return Response({
            'upload_id': upload_id,
            'filename': file.name,
            'sensitive_fields': sensitive_fields,
        }, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], url_path='index-gis/confirm')
    def index_gis_confirm(self, request):
        """
        Step 2: Confirm indexing (with or without sensitive-data acknowledgement).
        Queues the process_gis_file Celery task.
        """
        upload_id = request.data.get('upload_id')
        filename = request.data.get('filename', '')
        session_id = request.data.get('session_id')

        if not upload_id:
            return Response({'detail': 'upload_id is required.'}, status=status.HTTP_400_BAD_REQUEST)

        ext = os.path.splitext(filename)[1].lower() if filename else ''
        upload_dir = os.path.join(settings.MEDIA_ROOT, 'gis_uploads')
        save_path = os.path.join(upload_dir, f"{upload_id}{ext}")

        if not os.path.exists(save_path):
            return Response({'detail': 'Upload not found or expired.'}, status=status.HTTP_404_NOT_FOUND)

        task = AITask.objects.create(
            task_type=AITask.GIS_INDEXING,
            requested_by=request.user,
            input_data={
                'file_path': save_path,
                'filename': filename,
                'session_id': session_id,
                'upload_id': upload_id,
            },
        )
        from apps.ai_assistant.tasks import process_gis_file
        process_gis_file.delay(task.id)

        return Response({'task_id': task.id, 'detail': 'GIS file indexing queued.'}, status=status.HTTP_202_ACCEPTED)


class LLMConfigViewSet(viewsets.ModelViewSet):
    """SUPERADMIN-only CRUD for LLM backend configurations."""
    serializer_class = LLMConfigSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return LLMConfig.objects.all().order_by('-is_active', '-updated_at')

    def get_permissions(self):
        from apps.accounts.permissions import IsSuperAdmin
        return [IsSuperAdmin()]

    def perform_create(self, serializer):
        serializer.save(updated_by=self.request.user)

    def perform_update(self, serializer):
        serializer.save(updated_by=self.request.user)

    @action(detail=True, methods=['post'], url_path='activate')
    def activate(self, request, pk=None):
        """Set this config as active and deactivate all others."""
        cfg = self.get_object()
        LLMConfig.objects.exclude(pk=cfg.pk).update(is_active=False)
        cfg.is_active = True
        cfg.updated_by = request.user
        cfg.save(update_fields=['is_active', 'updated_by', 'updated_at'])
        return Response({'detail': f'"{cfg.name}" is now the active LLM config.'})

    @action(detail=True, methods=['post'], url_path='test')
    def test_connection(self, request, pk=None):
        """Probe the endpoint and optionally run a tiny inference test."""
        cfg = self.get_object()
        from .services import LLMService, _probe_url
        # Build a temporary service from this config's fields
        svc = LLMService.__new__(LLMService)
        svc.provider  = cfg.provider
        svc.base_url  = cfg.base_url.rstrip('/')
        svc.model     = cfg.model_name
        svc.api_key   = cfg.api_key or ''
        svc.timeout   = min(cfg.timeout, 30)  # cap test at 30 s

        reachable = _probe_url(svc.base_url, timeout=5, api_key=svc.api_key)
        if not reachable:
            return Response(
                {'ok': False, 'detail': f'Cannot reach {svc.base_url}'},
                status=status.HTTP_200_OK,
            )

        # Quick inference test
        try:
            reply = svc.chat([{'role': 'user', 'content': 'Reply with exactly: OK'}])
            return Response({'ok': True, 'detail': f'Connected. Model replied: {reply[:120]}'})
        except Exception as exc:
            return Response({'ok': False, 'detail': str(exc)})

    @action(detail=True, methods=['get'], url_path='models')
    def list_models(self, request, pk=None):
        """List models available at this config's endpoint."""
        cfg = self.get_object()
        from .services import LLMService
        svc = LLMService.__new__(LLMService)
        svc.provider = cfg.provider
        svc.base_url = cfg.base_url.rstrip('/')
        svc.model    = cfg.model_name
        svc.api_key  = cfg.api_key or ''
        svc.timeout  = 10
        models = svc.list_models()
        return Response({'models': models})

    # ── Model Hub ─────────────────────────────────────────────────────────────

    @action(detail=True, methods=['get'], url_path='hub-models')
    def hub_models(self, request, pk=None):
        """
        Return the model catalog for a given hub plus the set of already-installed
        model names so the frontend can hide installed entries in the browse list.

        Query param: hub = ollama | huggingface | localai | llamacpp
        """
        cfg = self.get_object()
        hub = request.query_params.get('hub', 'ollama')

        catalog = _hub_catalog(hub)
        installed = _installed_models(cfg, hub)

        # For LocalAI the catalog comes from the live gallery endpoint
        if hub == 'localai':
            try:
                headers = {'Authorization': f'Bearer {cfg.api_key}'} if cfg.api_key else {}
                r = httpx.get(f"{cfg.base_url.rstrip('/')}/models/available",
                              headers=headers, timeout=10)
                r.raise_for_status()
                catalog = [
                    {
                        'name':        m.get('name', ''),
                        'size':        m.get('size', ''),
                        'description': m.get('description', ''),
                        'tags':        m.get('tags', []),
                    }
                    for m in r.json()
                ]
            except Exception:
                catalog = []

        return Response({'hub': hub, 'catalog': catalog, 'installed': installed})

    @action(detail=True, methods=['post'], url_path='pull-model')
    def pull_model(self, request, pk=None):
        """Queue a Celery task to pull/download a model from the specified hub."""
        from .models import AITask
        from .tasks import pull_model_task

        cfg = self.get_object()
        hub = request.data.get('hub', 'ollama')
        model_name = request.data.get('model_name', '').strip()

        if not model_name:
            return Response({'detail': 'model_name is required.'}, status=400)

        input_data = {
            'hub':          hub,
            'model_name':   model_name,
            'endpoint_url': cfg.base_url.rstrip('/'),
            'api_key':      cfg.api_key or '',
            'config_id':    cfg.id,
        }
        if hub in ('huggingface', 'llamacpp'):
            input_data['repo_id']  = request.data.get('repo_id', model_name)
            input_data['filename'] = request.data.get('filename', 'model.gguf')
            input_data['save_as']  = request.data.get('save_as', request.data.get('filename', 'model.gguf'))
            input_data['hf_token'] = request.data.get('hf_token', cfg.api_key or '')

        task = AITask.objects.create(
            task_type=AITask.MODEL_PULL,
            requested_by=request.user,
            input_data=input_data,
        )
        pull_model_task.delay(task.id)

        return Response(
            {'task_id': task.id, 'model': model_name, 'hub': hub, 'detail': 'Pull queued.'},
            status=status.HTTP_202_ACCEPTED,
        )

    @action(detail=True, methods=['post'], url_path='delete-model')
    def delete_model(self, request, pk=None):
        """Delete an installed model from the backend."""
        cfg = self.get_object()
        model_name = request.data.get('model_name', '').strip()
        hub = request.data.get('hub', 'ollama')

        if not model_name:
            return Response({'detail': 'model_name is required.'}, status=400)

        headers = {'Authorization': f'Bearer {cfg.api_key}'} if cfg.api_key else {}

        if hub == 'ollama':
            try:
                r = httpx.request(
                    'DELETE', f"{cfg.base_url.rstrip('/')}/api/delete",
                    json={'model': model_name}, timeout=30,
                )
                r.raise_for_status()
                return Response({'detail': f'{model_name} deleted from Ollama.'})
            except httpx.HTTPStatusError as e:
                return Response({'detail': f'Ollama delete failed: {e.response.text}'},
                                status=e.response.status_code)

        elif hub in ('huggingface', 'llamacpp'):
            data_dir = os.environ.get('DATA_DIR', getattr(settings, 'DATA_DIR', '/data'))
            file_path = os.path.join(data_dir, 'models', 'llamacpp', model_name)
            if not os.path.exists(file_path):
                return Response({'detail': 'File not found.'}, status=404)
            os.remove(file_path)
            return Response({'detail': f'{model_name} deleted.'})

        elif hub == 'localai':
            try:
                r = httpx.delete(
                    f"{cfg.base_url.rstrip('/')}/models/{model_name}",
                    headers=headers, timeout=30,
                )
                return Response({'detail': f'{model_name} deleted from LocalAI.'})
            except Exception as exc:
                return Response({'detail': str(exc)}, status=500)

        return Response({'detail': f'Unknown hub: {hub}'}, status=400)


# ── Hub helpers (module-level, not class methods) ──────────────────────────────

_OLLAMA_CATALOG = [
    {'name': 'llama3.2',            'size': '2.0 GB', 'description': 'Meta Llama 3.2 3B — fast, general purpose',              'tags': ['chat', 'fast']},
    {'name': 'llama3.2:1b',         'size': '1.3 GB', 'description': 'Meta Llama 3.2 1B — ultra-lightweight',                  'tags': ['fast']},
    {'name': 'llama3.1',            'size': '4.7 GB', 'description': 'Meta Llama 3.1 8B — strong general model',               'tags': ['chat']},
    {'name': 'llama3.1:70b',        'size': '40 GB',  'description': 'Meta Llama 3.1 70B — highest quality, GPU recommended',  'tags': ['large', 'gpu']},
    {'name': 'mistral',             'size': '4.1 GB', 'description': 'Mistral 7B — excellent at instructions',                 'tags': ['chat']},
    {'name': 'mistral-nemo',        'size': '7.1 GB', 'description': 'Mistral NeMo 12B — long context',                       'tags': ['chat']},
    {'name': 'phi3',                'size': '2.3 GB', 'description': 'Microsoft Phi-3 Mini — very capable for its size',       'tags': ['fast']},
    {'name': 'phi3:medium',         'size': '7.9 GB', 'description': 'Microsoft Phi-3 Medium 14B',                            'tags': ['balanced']},
    {'name': 'gemma2:2b',           'size': '1.6 GB', 'description': 'Google Gemma 2 2B — fast and capable',                  'tags': ['fast']},
    {'name': 'gemma2',              'size': '5.4 GB', 'description': 'Google Gemma 2 9B',                                     'tags': ['balanced']},
    {'name': 'qwen2.5:0.5b',        'size': '0.4 GB', 'description': 'Alibaba Qwen 2.5 0.5B — tiny',                         'tags': ['fast']},
    {'name': 'qwen2.5',             'size': '4.7 GB', 'description': 'Alibaba Qwen 2.5 7B — multilingual, strong reasoning',  'tags': ['multilingual']},
    {'name': 'qwen2.5:72b',         'size': '47 GB',  'description': 'Alibaba Qwen 2.5 72B — very large, GPU required',       'tags': ['large', 'gpu']},
    {'name': 'codellama',           'size': '3.8 GB', 'description': 'Meta CodeLlama 7B — code generation',                   'tags': ['code']},
    {'name': 'codellama:13b',       'size': '7.4 GB', 'description': 'Meta CodeLlama 13B — stronger code model',              'tags': ['code']},
    {'name': 'deepseek-coder-v2',   'size': '8.9 GB', 'description': 'DeepSeek Coder V2 — code and math',                    'tags': ['code']},
    {'name': 'nomic-embed-text',    'size': '0.3 GB', 'description': 'Nomic text embedding model',                            'tags': ['embedding']},
    {'name': 'mxbai-embed-large',   'size': '0.7 GB', 'description': 'Mixed Bread AI large embedding',                       'tags': ['embedding']},
    {'name': 'llava',               'size': '4.7 GB', 'description': 'LLaVA — vision + language multimodal',                  'tags': ['multimodal']},
    {'name': 'moondream',           'size': '0.8 GB', 'description': 'Moondream2 — tiny vision model',                        'tags': ['multimodal', 'fast']},
]

_HF_CATALOG = [
    {'name': 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',      'repo_id': 'bartowski/Llama-3.2-1B-Instruct-GGUF',         'filename': 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',      'size': '0.8 GB',  'description': 'Llama 3.2 1B Instruct — Q4 quantised',       'tags': ['fast']},
    {'name': 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',      'repo_id': 'bartowski/Llama-3.2-3B-Instruct-GGUF',         'filename': 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',      'size': '2.0 GB',  'description': 'Llama 3.2 3B Instruct — Q4 quantised',       'tags': ['fast']},
    {'name': 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', 'repo_id': 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',   'filename': 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', 'size': '4.9 GB',  'description': 'Llama 3.1 8B Instruct — Q4 quantised',       'tags': ['balanced']},
    {'name': 'mistral-7b-instruct-v0.2.Q4_K_M.gguf',   'repo_id': 'TheBloke/Mistral-7B-Instruct-v0.2-GGUF',       'filename': 'mistral-7b-instruct-v0.2.Q4_K_M.gguf',   'size': '4.1 GB',  'description': 'Mistral 7B Instruct v0.2 — Q4',              'tags': ['balanced']},
    {'name': 'Phi-3.5-mini-instruct-Q4_K_M.gguf',      'repo_id': 'bartowski/Phi-3.5-mini-instruct-GGUF',         'filename': 'Phi-3.5-mini-instruct-Q4_K_M.gguf',      'size': '2.2 GB',  'description': 'Phi 3.5 Mini Instruct — Q4',                 'tags': ['fast']},
    {'name': 'gemma-2-2b-it-Q4_K_M.gguf',              'repo_id': 'bartowski/gemma-2-2b-it-GGUF',                 'filename': 'gemma-2-2b-it-Q4_K_M.gguf',              'size': '1.6 GB',  'description': 'Gemma 2 2B IT — Q4',                         'tags': ['fast']},
    {'name': 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',        'repo_id': 'bartowski/Qwen2.5-7B-Instruct-GGUF',           'filename': 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',        'size': '4.7 GB',  'description': 'Qwen 2.5 7B Instruct — Q4, multilingual',   'tags': ['multilingual']},
    {'name': 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',      'repo_id': 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',         'filename': 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',      'size': '0.4 GB',  'description': 'Qwen 2.5 0.5B Instruct — Q4, tiny',         'tags': ['fast']},
    {'name': 'CodeLlama-7b-Instruct-Q4_K_M.gguf',      'repo_id': 'TheBloke/CodeLlama-7B-Instruct-GGUF',          'filename': 'codellama-7b-instruct.Q4_K_M.gguf',      'size': '3.8 GB',  'description': 'CodeLlama 7B Instruct — Q4, code generation','tags': ['code']},
]

# LlamaCpp hub re-uses the HF GGUF catalog — same download path, different target awareness
_LLAMACPP_CATALOG = _HF_CATALOG


def _hub_catalog(hub: str) -> list:
    if hub == 'ollama':
        return _OLLAMA_CATALOG
    if hub in ('huggingface', 'llamacpp'):
        return _HF_CATALOG
    return []  # localai: dynamic, returned by hub_models view


def _installed_models(cfg, hub: str) -> list:
    """Return a list of already-installed model identifiers for the given hub."""
    base = cfg.base_url.rstrip('/')
    auth = {'Authorization': f'Bearer {cfg.api_key}'} if cfg.api_key else {}

    if hub == 'ollama':
        try:
            r = httpx.get(f"{base}/api/tags", timeout=5)
            r.raise_for_status()
            return [m['name'] for m in r.json().get('models', [])]
        except Exception:
            return []

    if hub in ('huggingface', 'llamacpp'):
        data_dir = os.environ.get('DATA_DIR', getattr(settings, 'DATA_DIR', '/data'))
        lc_dir = os.path.join(data_dir, 'models', 'llamacpp')
        try:
            return [f for f in os.listdir(lc_dir) if f.endswith('.gguf')]
        except Exception:
            return []

    if hub == 'localai':
        try:
            r = httpx.get(f"{base}/v1/models", headers=auth, timeout=5)
            r.raise_for_status()
            return [m['id'] for m in r.json().get('data', [])]
        except Exception:
            return []

    return []


# ── RAG: Embedding management ─────────────────────────────────────────────────

class EmbeddingViewSet(viewsets.ViewSet):
    """Manage document embeddings for RAG."""
    permission_classes = [permissions.IsAuthenticated]

    @staticmethod
    def _deny_unless_accessible(request, project_pk):
        """Org-scope gate shared by all per-project embedding endpoints."""
        from apps.survey_projects.access import ai_can_access_project
        if not ai_can_access_project(request.user, project_pk):
            return Response({'detail': 'You do not have access to this project.'},
                            status=status.HTTP_403_FORBIDDEN)
        return None

    @action(detail=False, methods=['post'], url_path='embed-project/(?P<project_pk>[^/.]+)')
    def embed_project(self, request, project_pk=None):
        """Queue embedding tasks for all AI-processed documents in a project."""
        from apps.documents.models import Document
        from .tasks import embed_document

        denied = self._deny_unless_accessible(request, project_pk)
        if denied:
            return denied

        embed_model = request.data.get('embed_model', 'nomic-embed-text')
        docs = Document.objects.filter(project_id=project_pk, ai_processed=True).exclude(ai_extracted_text='')
        if not docs.exists():
            return Response({'detail': 'No processed documents found. Run AI processing first.'}, status=400)

        task_ids = []
        for doc in docs:
            task = AITask.objects.create(
                task_type=AITask.DOCUMENT_EMBEDDING,
                requested_by=request.user,
                input_data={'document_id': doc.id, 'embed_model': embed_model},
            )
            embed_document.delay(task.id)
            task_ids.append(task.id)

        return Response({'queued': len(task_ids), 'task_ids': task_ids, 'embed_model': embed_model})

    @action(detail=False, methods=['get'], url_path='embed-status/(?P<project_pk>[^/.]+)')
    def embed_status(self, request, project_pk=None):
        """Return RAG embedding status for a project."""
        from apps.documents.models import Document

        denied = self._deny_unless_accessible(request, project_pk)
        if denied:
            return denied

        total_docs = Document.objects.filter(project_id=project_pk, ai_processed=True).count()
        embedded_docs = DocumentChunk.objects.filter(project_id=project_pk).values('document_id').distinct().count()
        total_chunks  = DocumentChunk.objects.filter(project_id=project_pk).count()

        pending_tasks = AITask.objects.filter(
            task_type=AITask.DOCUMENT_EMBEDDING,
            input_data__document_id__in=list(
                Document.objects.filter(project_id=project_pk).values_list('id', flat=True)
            ),
            status__in=(AITask.PENDING, AITask.RUNNING),
        ).count()

        return Response({
            'total_docs': total_docs,
            'embedded_docs': embedded_docs,
            'total_chunks': total_chunks,
            'pending_tasks': pending_tasks,
            'rag_ready': embedded_docs > 0 and pending_tasks == 0,
        })

    @action(detail=False, methods=['delete'], url_path='clear-embeddings/(?P<project_pk>[^/.]+)')
    def clear_embeddings(self, request, project_pk=None):
        """Delete all embeddings for a project."""
        denied = self._deny_unless_accessible(request, project_pk)
        if denied:
            return denied
        count, _ = DocumentChunk.objects.filter(project_id=project_pk).delete()
        return Response({'deleted_chunks': count})

    @action(detail=False, methods=['post'], url_path='create-dgde-model')
    def create_dgde_model(self, request):
        """
        Create a DGDE-domain-expert Ollama model from a Modelfile.
        The model uses the comprehensive DGDE system prompt baked in.
        After creation, register it as an LLMConfig.
        """
        from .services import DGDE_SYSTEM_PROMPT, LLMService
        import subprocess, tempfile

        base_model = request.data.get('base_model', 'llama3.2')
        model_name = request.data.get('model_name', 'dgde-expert')
        temperature = float(request.data.get('temperature', '0.3'))

        modelfile = f"""FROM {base_model}
SYSTEM \"\"\"{DGDE_SYSTEM_PROMPT}\"\"\"
PARAMETER temperature {temperature}
PARAMETER top_p 0.9
PARAMETER num_ctx 4096
"""
        svc = LLMService()
        try:
            # Write modelfile to temp, then call ollama create via API
            # Ollama doesn't have a direct "create from modelfile" REST API yet,
            # so we POST to /api/create
            import httpx
            r = httpx.post(
                f"{svc.base_url}/api/create",
                json={'name': model_name, 'modelfile': modelfile},
                timeout=300,
            )
            r.raise_for_status()

            # Register as LLMConfig
            LLMConfig.objects.filter(model_name=model_name, provider=LLMConfig.OLLAMA).delete()
            cfg = LLMConfig.objects.create(
                name=f'DGDE Expert ({base_model} base)',
                provider=LLMConfig.OLLAMA,
                base_url=svc.base_url,
                model_name=model_name,
                notes=f'Domain-specific model created from {base_model} with DGDE system prompt.',
                updated_by=request.user,
            )
            return Response({'detail': f'Model "{model_name}" created.', 'config_id': cfg.id})
        except Exception as exc:
            return Response({'detail': f'Model creation failed: {exc}'}, status=500)


# ── Vision: Boundary Extraction ───────────────────────────────────────────────

class BoundaryExtractionViewSet(viewsets.ViewSet):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    @action(detail=False, methods=['post'], url_path='extract-classical',
            parser_classes=[MultiPartParser, FormParser, JSONParser])
    def extract_classical(self, request):
        """
        POST /ai/vision/extract-classical/

        Industry-standard classical GIS pipeline:
          GeoTIFF → edge detection → morphological closing
          → connected components → GDAL Polygonize → GeoJSON features

        No vision LLM required. Output saved as draft_features on a
        BoundaryExtractionJob so the same accept-features flow applies.

        Body (JSON or form):
          project_id         — required
          source_geotiff_id  — required: GeoTiffLayer id
          edge_sensitivity   — float 0.0–1.0  (default 0.3; higher = more edges)
          min_area_m2        — float m²       (default 500)
          dilation_px        — int            (default 3)
          simplify_tolerance — float degrees  (default 0.00005)
          ai_label           — bool: run vision LLM to label each polygon type after
                               classical extraction (default false)
          vision_model       — model name for ai_label step (default llava:7b)
        """
        import json as _json
        from apps.survey_projects.models import SurveyProject, GeoTiffLayer
        from .tasks import extract_polygons_classical

        project_id        = request.data.get('project_id')
        source_geotiff_id = request.data.get('source_geotiff_id')

        if not project_id:
            return Response({'detail': 'project_id is required.'}, status=400)
        if not source_geotiff_id:
            return Response({'detail': 'source_geotiff_id is required.'}, status=400)

        try:
            project = SurveyProject.objects.get(pk=project_id)
        except SurveyProject.DoesNotExist:
            return Response({'detail': 'Project not found.'}, status=404)

        try:
            geotiff = GeoTiffLayer.objects.get(pk=source_geotiff_id, project=project)
        except GeoTiffLayer.DoesNotExist:
            return Response({'detail': 'GeoTiff layer not found in this project.'}, status=404)

        if geotiff.status != GeoTiffLayer.DONE:
            return Response(
                {'detail': f'GeoTiff COG conversion is {geotiff.status}. Wait until status is DONE.'},
                status=400,
            )

        # Collect pipeline parameters
        pipeline_params = {
            'edge_sensitivity':   float(request.data.get('edge_sensitivity',   0.3)),
            'min_area_m2':        float(request.data.get('min_area_m2',        500.0)),
            'dilation_px':        int(request.data.get('dilation_px',          3)),
            'simplify_tolerance': float(request.data.get('simplify_tolerance', 0.00005)),
            'ai_label':           str(request.data.get('ai_label', 'false')).lower() == 'true',
            'vision_model':       request.data.get('vision_model', 'llava:7b'),
        }

        job = BoundaryExtractionJob(
            project=project,
            source_geotiff=geotiff,
            vision_model=pipeline_params['vision_model'],
            requested_by=request.user,
            # Temporarily store params in raw_response; task reads and clears it
            raw_response=_json.dumps(pipeline_params),
        )
        job.save()

        extract_polygons_classical.delay(job.id)

        return Response({
            'job_id':  job.id,
            'status':  job.status,
            'mode':    'classical_gis',
            'params':  pipeline_params,
        }, status=201)

    @action(detail=False, methods=['post'], url_path='extract-pipeline',
            parser_classes=[MultiPartParser, FormParser, JSONParser])
    def extract_pipeline(self, request):
        """
        POST /ai/vision/extract-pipeline/

        Advanced 10-stage AI Vision pipeline:
          GeoTIFF → Rasterio/GDAL → Tile Generation → SAM 2.1 → U-Net++
          → Boundary Graph → Polygonize → PaddleOCR/TrOCR → Geospatial Validation
          → LLM QA Review → Database Output

        Body (JSON or form):
          project_id         — required
          source_geotiff_id  — required: GeoTiffLayer id
          tile_size          — int (1024 or 2048, default 1024)
          vision_model       — model name for AI steps (default llava:7b)
          min_area_m2        — float m² (default 500)
          simplify_tolerance — float degrees (default 0.00005)
          edge_sensitivity   — float 0.0–1.0 (default 0.3)
          dilation_px        — int (default 3)
        """
        import json as _json
        from apps.survey_projects.models import SurveyProject, GeoTiffLayer
        from .tasks import extract_polygons_ai_pipeline

        project_id        = request.data.get('project_id')
        source_geotiff_id = request.data.get('source_geotiff_id')

        if not project_id:
            return Response({'detail': 'project_id is required.'}, status=400)
        if not source_geotiff_id:
            return Response({'detail': 'source_geotiff_id is required.'}, status=400)

        try:
            project = SurveyProject.objects.get(pk=project_id)
        except SurveyProject.DoesNotExist:
            return Response({'detail': 'Project not found.'}, status=404)

        try:
            geotiff = GeoTiffLayer.objects.get(pk=source_geotiff_id, project=project)
        except GeoTiffLayer.DoesNotExist:
            return Response({'detail': 'GeoTiff layer not found in this project.'}, status=404)

        if geotiff.status != GeoTiffLayer.DONE:
            return Response(
                {'detail': f'GeoTiff COG conversion is {geotiff.status}. Wait until status is DONE.'},
                status=400,
            )

        # The Advanced AI Vision Pipeline runs vision LLM inference and requires GPU.
        if not settings.AI_GPU_ENABLED:
            return Response(
                {
                    'detail': (
                        'The Advanced AI Vision Pipeline requires GPU mode, but the AI '
                        'backend is running in CPU mode (AI_BACKEND_GPU). Use the '
                        'classical extraction pipeline on CPU, or start a GPU backend '
                        '(docker compose --profile docker-ollama-gpu up -d and set '
                        'AI_BACKEND_GPU=true).'
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Collect parameters
        pipeline_params = {
            'tile_size':          int(request.data.get('tile_size', 1024)),
            'vision_model':       request.data.get('vision_model', 'llava:7b'),
            'min_area_m2':        float(request.data.get('min_area_m2', 500.0)),
            'simplify_tolerance': float(request.data.get('simplify_tolerance', 0.00005)),
            'edge_sensitivity':   float(request.data.get('edge_sensitivity', 0.3)),
            'dilation_px':        int(request.data.get('dilation_px', 3)),
        }

        # Resolve vision model to installed variants if needed
        from .services import LLMService
        svc = LLMService()
        installed = svc.list_vision_models()

        resolved_model = pipeline_params['vision_model']
        if installed:
            if resolved_model in installed:
                pass
            else:
                family = resolved_model.split(':')[0].lower()
                family_matches = [m for m in installed if m.split(':')[0].lower() == family]
                if family_matches:
                    resolved_model = family_matches[0]
                else:
                    return Response(
                        {
                            'detail': (
                                f"Vision model '{resolved_model}' is not installed in Ollama. "
                                f"Pull it first:  ollama pull {resolved_model}. "
                                f"Installed vision models: {', '.join(installed)}."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

        job = BoundaryExtractionJob(
            project=project,
            source_geotiff=geotiff,
            vision_model=resolved_model,
            requested_by=request.user,
            raw_response=_json.dumps(pipeline_params),
        )
        job.save()

        extract_polygons_ai_pipeline.delay(job.id)

        return Response({
            'job_id':  job.id,
            'status':  job.status,
            'mode':    'ai_pipeline',
            'params':  pipeline_params,
        }, status=201)

    @action(detail=False, methods=['get'], url_path='list-vision-models')
    def list_vision_models(self, request):
        """
        GET /ai/vision/list-vision-models/
        Returns the list of vision-capable models currently installed in Ollama.
        Empty list means Ollama is unreachable or no vision model is installed.
        """
        from .services import LLMService
        try:
            svc = LLMService()
            models = svc.list_vision_models()
        except Exception:
            models = []
        return Response({'models': models, 'ollama_url': getattr(svc, 'base_url', '')})

    @action(detail=False, methods=['get'], url_path='capabilities')
    def capabilities(self, request):
        """
        GET /ai/vision/capabilities/
        Reports which extraction pipelines are available in the current AI compute
        mode. The classical CV pipeline always runs (CPU or GPU); the vision
        pipelines require GPU mode (AI_BACKEND_GPU).
        """
        gpu = bool(settings.AI_GPU_ENABLED)
        return Response({
            'gpu_enabled': gpu,
            'mode': 'gpu' if gpu else 'cpu',
            'pipelines': {
                'classical':   {'available': True, 'requires_gpu': False},
                'ai_vision':   {'available': gpu,  'requires_gpu': True},
                'ai_pipeline': {'available': gpu,  'requires_gpu': True},
            },
        })

    @action(detail=False, methods=['post'], url_path='submit')
    def submit(self, request):
        """
        Submit a map image for vision-based boundary extraction.

        Body (multipart/form-data):
          project_id        — required
          vision_model      — default llava:7b
          image             — uploaded scanned map image  (mode A: scan)
          source_document_id— existing document id        (mode A: scan)
          source_geotiff_id — GeoTiffLayer id             (mode B: geotiff → real coords)
        """
        from apps.survey_projects.models import SurveyProject, GeoTiffLayer
        from apps.documents.models import Document
        from .tasks import extract_map_boundaries

        project_id        = request.data.get('project_id')
        vision_model      = request.data.get('vision_model', 'llava:7b')
        source_doc_id     = request.data.get('source_document_id')
        source_geotiff_id = request.data.get('source_geotiff_id')
        uploaded_image    = request.FILES.get('image')

        if not project_id:
            return Response({'detail': 'project_id required.'}, status=400)
        if not source_doc_id and not uploaded_image and not source_geotiff_id:
            return Response(
                {'detail': 'Provide source_geotiff_id, source_document_id, or an image file.'},
                status=400,
            )

        try:
            project = SurveyProject.objects.get(pk=project_id)
        except SurveyProject.DoesNotExist:
            return Response({'detail': 'Project not found.'}, status=404)

        # AI Vision (LLaVA) runs vision LLM inference and requires GPU mode.
        if not settings.AI_GPU_ENABLED:
            return Response(
                {
                    'detail': (
                        'AI Vision (LLaVA) requires GPU mode, but the AI backend is '
                        'running in CPU mode (AI_BACKEND_GPU). Use the classical '
                        'extraction pipeline on CPU, or start a GPU backend '
                        '(docker compose --profile docker-ollama-gpu up -d and set '
                        'AI_BACKEND_GPU=true).'
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        job = BoundaryExtractionJob(
            project=project,
            vision_model=vision_model,
            requested_by=request.user,
        )
        if source_geotiff_id:
            try:
                job.source_geotiff = GeoTiffLayer.objects.get(pk=source_geotiff_id, project=project)
            except GeoTiffLayer.DoesNotExist:
                return Response({'detail': 'GeoTiff layer not found in this project.'}, status=404)
        elif source_doc_id:
            job.source_document_id = source_doc_id
        elif uploaded_image:
            job.source_image = uploaded_image
        job.save()

        # Pre-flight: resolve the vision model to whatever is actually installed.
        # The user may request 'llava:7b' but Ollama only has 'llava:latest' or 'llava'.
        # Strategy: exact match → same family → error.
        from .services import LLMService
        svc = LLMService()
        installed = svc.list_vision_models()

        resolved_model = vision_model
        if installed:
            if vision_model in installed:
                # Exact match — use as-is
                resolved_model = vision_model
            else:
                # Try to find an installed model from the same family (before the colon)
                family = vision_model.split(':')[0].lower()
                family_matches = [m for m in installed if m.split(':')[0].lower() == family]
                if family_matches:
                    # Use the closest installed variant (prefer same family)
                    resolved_model = family_matches[0]
                else:
                    # No match at all — fail fast
                    job.delete()
                    return Response(
                        {
                            'detail': (
                                f"Vision model '{vision_model}' is not installed in Ollama "
                                f"and no matching model was found. "
                                f"Pull it first:  ollama pull {vision_model}  "
                                f"Installed vision models: {', '.join(installed)}."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

            # Persist the resolved model name on the job so the task uses the right tag
            if resolved_model != vision_model:
                job.vision_model = resolved_model
                job.save(update_fields=['vision_model'])

        extract_map_boundaries.delay(job.id)
        return Response({
            'job_id': job.id,
            'status': job.status,
            'mode': 'geotiff' if source_geotiff_id else 'scan',
        }, status=201)

    @action(detail=False, methods=['post'], url_path='accept-features/(?P<job_pk>[^/.]+)')
    def accept_features(self, request, job_pk=None):
        """
        POST /ai/vision/accept-features/{job_id}/

        Save draft polygon features from a completed GeoTiff extraction job as
        GISFeature records in the project, linked to a survey area.

        Body (JSON):
          layer_name       — GIS layer name for the created features (required)
          survey_area_id   — existing SurveyArea id  (provide this OR new_area_name)
          new_area_name    — create a new SurveyArea with this name
          features         — edited GeoJSON Feature list to save (from the review
                             editor). Takes precedence over the stored draft, so
                             reshaped/split/merged geometry and edited Survey
                             Numbers are persisted.
          feature_indices  — list of draft_feature indices to save; omit = all
                             (ignored when `features` is provided)
        """
        from apps.survey_projects.models import (
            SurveyArea, GISFeature, ProjectLayerFolder,
        )
        from django.contrib.gis.geos import GEOSGeometry

        try:
            job = BoundaryExtractionJob.objects.select_related('project').get(
                pk=job_pk,
            )
        except BoundaryExtractionJob.DoesNotExist:
            return Response({'detail': 'Job not found.'}, status=404)

        if job.status != BoundaryExtractionJob.DONE:
            return Response({'detail': f'Job is not DONE yet (status={job.status}).'}, status=400)

        draft = job.draft_features or []
        edited_features  = request.data.get('features')  # edited GeoJSON list or None
        if not draft and not edited_features:
            return Response({'detail': 'No draft features to save.'}, status=400)

        layer_name       = (request.data.get('layer_name') or '').strip()
        survey_area_id   = request.data.get('survey_area_id')
        new_area_name    = (request.data.get('new_area_name') or '').strip()
        feature_indices  = request.data.get('feature_indices')  # list or None

        if not layer_name:
            return Response({'detail': 'layer_name is required.'}, status=400)
        if not survey_area_id and not new_area_name:
            return Response(
                {'detail': 'Provide survey_area_id or new_area_name.'}, status=400
            )

        project = job.project

        # ── Resolve / create survey area ──────────────────────────────────────
        if survey_area_id:
            try:
                area = SurveyArea.objects.get(pk=survey_area_id, project=project)
            except SurveyArea.DoesNotExist:
                return Response({'detail': 'Survey area not found in this project.'}, status=404)
        else:
            area, created = SurveyArea.objects.get_or_create(
                project=project,
                name=new_area_name,
                defaults={'created_by': request.user, 'status': SurveyArea.DRAFT},
            )
            if created:
                # Auto-create root folder for the new area
                root = ProjectLayerFolder.objects.create(
                    project=project,
                    name=new_area_name,
                    folder_type=ProjectLayerFolder.ZONE,
                    created_by=request.user,
                    order=0,
                )
                area.folder = root
                area.save(update_fields=['folder'])

        target_folder = area.folder  # may be None if area has no folder yet

        # ── Pick which features to save ────────────────────────────────────────
        # Edited features from the review editor win over the stored draft.
        if isinstance(edited_features, list):
            selected = edited_features
        elif feature_indices is not None:
            selected = [draft[i] for i in feature_indices if 0 <= i < len(draft)]
        else:
            selected = draft

        import json as _json
        created_count = 0
        skipped_count = 0
        created_features = []

        for feat in selected:
            geom_json = feat.get('geometry')
            if not geom_json:
                skipped_count += 1
                continue
            try:
                geom = GEOSGeometry(_json.dumps(geom_json), srid=4326)
            except Exception:
                skipped_count += 1
                continue

            props = feat.get('properties', {})
            geom_type = (getattr(geom, 'geom_type', '') or 'POLYGON').upper()
            gf = GISFeature.objects.create(
                project=project,
                folder=target_folder,
                layer_name=layer_name,
                geometry_type=geom_type,
                geometry=geom,
                attributes={k: v for k, v in props.items() if k not in ('source', 'has_coordinates')},
                created_by=request.user,
            )
            created_count += 1
            created_features.append(gf)

        # Broadcast each created feature via WebSocket so the map viewer
        # updates in real-time without requiring a manual page refresh.
        if created_features:
            try:
                from channels.layers import get_channel_layer
                from asgiref.sync import async_to_sync
                channel_layer = get_channel_layer()
                if channel_layer:
                    room = f'project_{project.id}'
                    for gf in created_features:
                        async_to_sync(channel_layer.group_send)(room, {
                            'type': 'collab.feature_created',
                            'feature': {
                                'id': gf.id,
                                'geometry': _json.loads(gf.geometry.geojson),
                                'layer_name': gf.layer_name,
                                'geometry_type': gf.geometry_type,
                                'attributes': gf.attributes,
                                'folder': gf.folder_id,
                                'feature_id': gf.feature_id or '',
                            },
                            'sender_id': request.user.id,
                        })
            except Exception:
                pass  # WebSocket broadcast is best-effort; don't fail the save

        return Response({
            'created': created_count,
            'skipped': skipped_count,
            'survey_area_id': area.id,
            'survey_area_name': area.name,
            'layer_name': layer_name,
            'project_id': project.id,
        })

    @action(detail=False, methods=['get'], url_path='status/(?P<job_pk>[^/.]+)')
    def job_status(self, request, job_pk=None):
        try:
            job = BoundaryExtractionJob.objects.select_related('source_geotiff', 'project').get(
                pk=job_pk, project__organisation=request.user.organisation)
        except BoundaryExtractionJob.DoesNotExist:
            return Response({'detail': 'Not found.'}, status=404)
        # Source GeoTIFF (COG) so the review viewer can overlay it for context.
        source_geotiff = None
        gt = job.source_geotiff
        if gt and gt.cog_file:
            try:
                cog_url = request.build_absolute_uri(gt.cog_file.url)
            except Exception:
                cog_url = gt.cog_file.url
            source_geotiff = {'id': gt.id, 'name': gt.name, 'cog_url': cog_url, 'status': gt.status}
        return Response({
            'id': job.id,
            'status': job.status,
            'project_id': job.project_id,
            'vision_model': job.vision_model,
            'parsed_result': job.parsed_result,
            'draft_features': job.draft_features,
            'source_geotiff': source_geotiff,
            'raw_response': job.raw_response[:500] if job.raw_response else '',
            'error_log': job.error_log,
            'created_at': job.created_at,
            'completed_at': job.completed_at,
        })

    @action(detail=False, methods=['get'], url_path='list/(?P<project_pk>[^/.]+)')
    def list_jobs(self, request, project_pk=None):
        jobs = BoundaryExtractionJob.objects.filter(project_id=project_pk).order_by('-created_at')[:20]
        return Response([{
            'id': j.id, 'status': j.status, 'vision_model': j.vision_model,
            'parcel_count': len(j.parsed_result.get('parcels', [])) if j.parsed_result else 0,
            'created_at': j.created_at,
        } for j in jobs])

    @action(detail=False, methods=['post'], url_path='export-training/(?P<project_pk>[^/.]+)')
    def export_training(self, request, project_pk=None):
        """Export project documents as JSONL training data for local fine-tuning."""
        from .tasks import export_training_dataset

        task = AITask.objects.create(
            task_type=AITask.TRAINING_EXPORT,
            requested_by=request.user,
            input_data={'project_id': project_pk},
        )
        export_training_dataset.delay(task.id)
        return Response({'task_id': task.id, 'detail': 'Training export queued.'})
