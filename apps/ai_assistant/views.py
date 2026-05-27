import json
import os
import tempfile

import httpx
from django.conf import settings
from django.http import FileResponse, Http404
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response

from .models import ChatSession, ChatMessage, AITask, LLMConfig
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

        ChatMessage.objects.create(session=session, role=ChatMessage.USER, content=user_message)

        history = list(session.messages.values('role', 'content').order_by('timestamp'))
        ollama_messages = [
            {'role': msg['role'].lower(), 'content': msg['content']}
            for msg in history
        ]

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
        try:
            reply = service.chat(ollama_messages)
        except Exception as exc:
            return Response(
                {'detail': f'AI inference failed ({service.base_url}, model={service.model}): {exc}'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        assistant_msg = ChatMessage.objects.create(session=session, role=ChatMessage.ASSISTANT, content=reply)

        session.save(update_fields=['updated_at'])

        return Response(ChatMessageSerializer(assistant_msg).data)


class AITaskViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AITaskSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.role in ('SUPERADMIN', 'PDDE_VIEWER', 'DEO_ADMIN'):
            return AITask.objects.select_related('requested_by').all()
        return AITask.objects.select_related('requested_by').filter(requested_by=user)

    @action(detail=False, methods=['post'], url_path='generate-report/(?P<project_pk>[^/.]+)')
    def generate_report(self, request, project_pk=None):
        from apps.ai_assistant.tasks import generate_project_report

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

        return FileResponse(
            open(abs_path, 'rb'),
            as_attachment=True,
            filename=os.path.basename(abs_path),
            content_type='text/plain; charset=utf-8',
        )

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
