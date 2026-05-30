import json
import os
import time

from django.conf import settings
from django.core.files.base import ContentFile
from django.http import FileResponse, Http404, HttpResponse
from django.utils.html import escape as html_escape
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter

from apps.accounts.permissions import CanEditProject, org_queryset_filter
from .models import Document
from .serializers import DocumentSerializer


class DocumentViewSet(viewsets.ModelViewSet):
    serializer_class = DocumentSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['project', 'folder', 'category', 'ai_processed']
    search_fields = ['title']

    def get_queryset(self):
        from django.db.models import Q
        from apps.accounts.permissions import get_shared_project_ids, get_approved_area_ids
        user = self.request.user
        base_qs = Document.objects.select_related('project__organisation', 'uploaded_by', 'folder')
        own_qs = org_queryset_filter(user, base_qs, org_field='project__organisation')
        if user.is_superadmin or user.role == 'PDDE_VIEWER':
            return own_qs
        shared_project_ids = get_shared_project_ids(user)
        approved_area_ids  = get_approved_area_ids(user)
        if not shared_project_ids and not approved_area_ids:
            return own_qs
        from apps.survey_projects.models import SurveyArea, ProjectLayerFolder
        from collections import deque
        approved_folder_ids: list[int] = []
        for area in SurveyArea.objects.filter(id__in=approved_area_ids).select_related('folder'):
            if area.folder_id:
                queue: deque = deque([area.folder_id])
                while queue:
                    cur = queue.popleft()
                    approved_folder_ids.append(cur)
                    for cid in ProjectLayerFolder.objects.filter(parent_id=cur).values_list('id', flat=True):
                        queue.append(cid)
        extra_q = Q(project_id__in=shared_project_ids)
        if approved_folder_ids:
            extra_q |= Q(folder_id__in=approved_folder_ids)
        return (own_qs | base_qs.filter(extra_q)).distinct()

    def get_permissions(self):
        if self.action == 'embed':
            # embed authenticates manually via ?token= query param (browser tab
            # cannot send a Bearer header); DRF auth must not block it first.
            return [permissions.AllowAny()]
        # Allow OnlyOffice server callbacks without DRF authentication so the
        # documentserver can POST save events. We'll validate the JWT token
        # inside the view itself (OnlyOffice sends the token in the POST body).
        if self.action == 'onlyoffice_callback':
            return [permissions.AllowAny()]
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [CanEditProject()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        file = self.request.FILES.get('file')
        mime_type = ''
        file_size = 0
        if file:
            try:
                import magic
                mime_type = magic.from_buffer(file.read(2048), mime=True)
                file.seek(0)
            except Exception:
                pass
            file_size = file.size
        serializer.save(
            uploaded_by=self.request.user,
            mime_type=mime_type,
            file_size=file_size,
        )

    @action(detail=True, methods=['get'], url_path='editor-config')
    def editor_config(self, request, pk=None):
        """Return JWT-signed OnlyOffice DocsAPI config for this document."""
        import jwt

        doc = self.get_object()
        secret = getattr(settings, 'ONLYOFFICE_JWT_SECRET', '')
        internal_base = getattr(settings, 'ONLYOFFICE_INTERNAL_BASE_URL', '').rstrip('/')

        if internal_base:
            doc_url = f"{internal_base}{doc.file.url}"
            callback_url = f"{internal_base}/api/documents/{doc.id}/onlyoffice-callback/"
        else:
            doc_url = request.build_absolute_uri(doc.file.url)
            callback_url = request.build_absolute_uri(f'/api/documents/{doc.id}/onlyoffice-callback/')

        raw_name = doc.file.name.rsplit('/', 1)[-1]
        ext = raw_name.rsplit('.', 1)[-1].lower() if '.' in raw_name else 'docx'
        if ext in ('doc', 'docx', 'odt', 'rtf', 'txt'):
            doc_type = 'word'
        elif ext in ('xls', 'xlsx', 'csv', 'ods'):
            doc_type = 'cell'
        else:
            doc_type = 'slide'

        can_edit = (
            request.user.is_superadmin
            or request.user.organisation_id == doc.project.organisation_id
        )

        title = doc.title if '.' in doc.title else f"{doc.title}.{ext}"

        config = {
            "document": {
                "fileType": ext,
                "key": f"doc-{doc.id}-v{doc.version}-{int(time.time() // 60)}",
                "title": title,
                "url": doc_url,
                "permissions": {
                    "edit": can_edit,
                    "download": True,
                    "print": True,
                    "review": can_edit,
                },
            },
            "documentType": doc_type,
            "editorConfig": {
                "callbackUrl": callback_url,
                "lang": "en",
                "mode": "edit" if can_edit else "view",
                "user": {
                    "id": str(request.user.id),
                    "name": request.user.get_full_name() or request.user.username,
                },
                "customization": {
                    "autosave": True,
                    "forcesave": False,
                    "chat": False,
                    "compactHeader": True,
                },
            },
        }

        if secret:
            token = jwt.encode(config, secret, algorithm='HS256')
            if isinstance(token, bytes):
                token = token.decode('utf-8')
            config['token'] = token

        return Response(config)

    @action(detail=True, methods=['get'], url_path='embed',
            permission_classes=[permissions.AllowAny])
    def embed(self, request, pk=None):
        """
        GET /api/documents/{id}/embed/?token=<jwt>

        Standalone HTML page that opens a document in the OnlyOffice editor.
        Authentication is via JWT passed in the `token` query parameter because
        browser tabs opened with window.open() cannot send a Bearer header.

        The OnlyOffice server fetches the document from the internal Docker URL;
        the browser never navigates to that URL directly.
        """
        import jwt as _jwt
        from rest_framework_simplejwt.tokens import UntypedToken
        from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
        from django.contrib.auth import get_user_model

        # ── Authenticate via ?token= query parameter ──────────────────────
        token_param = request.query_params.get('token', '')
        if not token_param:
            return HttpResponse(
                '<h2 style="font-family:sans-serif;color:#c00;padding:24px">'
                'Missing ?token= parameter. '
                'Open documents via the RakshaGIS interface.</h2>',
                content_type='text/html', status=401,
            )
        try:
            validated = UntypedToken(token_param)
            User = get_user_model()
            user = User.objects.get(id=validated['user_id'])
        except (InvalidToken, TokenError, Exception):
            return HttpResponse(
                '<h2 style="font-family:sans-serif;color:#c00;padding:24px">'
                'Session expired or invalid token. '
                'Please return to RakshaGIS and try again.</h2>',
                content_type='text/html', status=401,
            )
        request.user = user   # attach for permission checks below

        doc = self.get_object()
        secret = getattr(settings, 'ONLYOFFICE_JWT_SECRET', '')
        internal_base = getattr(settings, 'ONLYOFFICE_INTERNAL_BASE_URL', '').rstrip('/')

        # document.url  → OnlyOffice server fetches this (internal Docker URL)
        # callbackUrl   → OnlyOffice server POSTs save events here (internal Docker URL)
        if internal_base:
            doc_url = f"{internal_base}{doc.file.url}"
            callback_url = f"{internal_base}/api/documents/{doc.id}/onlyoffice-callback/"
        else:
            doc_url = request.build_absolute_uri(doc.file.url)
            callback_url = request.build_absolute_uri(f'/api/documents/{doc.id}/onlyoffice-callback/')

        raw_name = doc.file.name.rsplit('/', 1)[-1]
        ext = raw_name.rsplit('.', 1)[-1].lower() if '.' in raw_name else 'docx'
        doc_type = ('word'  if ext in ('doc', 'docx', 'odt', 'rtf', 'txt') else
                    'cell'  if ext in ('xls', 'xlsx', 'csv', 'ods')         else
                    'slide')

        can_edit = (
            request.user.is_superadmin
            or request.user.organisation_id == doc.project.organisation_id
        )
        title = doc.title if '.' in doc.title else f"{doc.title}.{ext}"

        config = {
            "document": {
                "fileType": ext,
                "key": f"doc-{doc.id}-v{doc.version}-{int(time.time() // 60)}",
                "title": title,
                "url": doc_url,
                "permissions": {
                    "edit": can_edit, "download": True,
                    "print": True, "review": can_edit,
                },
            },
            "documentType": doc_type,
            "editorConfig": {
                "callbackUrl": callback_url,
                "lang": "en",
                "mode": "edit" if can_edit else "view",
                "user": {
                    "id": str(request.user.id),
                    "name": request.user.get_full_name() or request.user.username,
                },
                "customization": {
                    "autosave": True, "forcesave": False,
                    "chat": False, "compactHeader": True,
                    "goback": {"url": request.META.get('HTTP_REFERER', '/documents')},
                },
            },
        }

        if secret:
            token = _jwt.encode(config, secret, algorithm='HS256')
            if isinstance(token, bytes):
                token = token.decode('utf-8')
            config['token'] = token

        # Embed JSON safely inside a <script> tag: escape only the characters
        # that could break out of the script context. Do NOT html-escape the
        # whole blob — that would corrupt the JSON (quotes → &quot; etc).
        config_json = (
            json.dumps(config)
            .replace('<', '\\u003c')
            .replace('>', '\\u003e')
            .replace('&', '\\u0026')
        )
        # title_safe goes into HTML text content → Django's escape (single arg)
        title_safe = html_escape(title)

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>{title_safe} — RakshaGIS</title>
  <style>
    * {{ margin:0; padding:0; box-sizing:border-box; }}
    body {{ background:#1a1a2e; font-family:Arial,sans-serif; height:100vh; display:flex; flex-direction:column; }}
    #header {{
      background:#0d2b5e; color:#fff; padding:8px 16px;
      display:flex; align-items:center; gap:12px; flex-shrink:0;
      font-size:14px; border-bottom:2px solid #1e5091;
    }}
    #header strong {{ font-size:15px; }}
    #editor {{ flex:1; }}
    .loading {{
      color:#aaa; text-align:center; padding:60px;
      font-size:16px;
    }}
    .error {{
      color:#ff6b6b; background:#1e1e1e; padding:24px;
      border:1px solid #ff4d4f; border-radius:4px; margin:20px;
    }}
  </style>
</head>
<body>
  <div id="header">
    <span>🗂</span>
    <strong>{title_safe}</strong>
    <span style="color:#90b8d8;font-size:12px">RakshaGIS — DGDE Survey Platform</span>
  </div>
  <div id="editor"><div class="loading">Loading document editor…</div></div>
  <script src="/onlyoffice/web-apps/apps/api/documents/api.js"></script>
  <script>
    (function() {{
      var config = {config_json};
      config.width  = '100%';
      config.height = '100%';
      config.events = {{
        onError: function(e) {{
          document.getElementById('editor').innerHTML =
            '<div class="error"><b>Editor error:</b> ' +
            (e && e.data ? e.data : 'Unknown error') + '</div>';
        }}
      }};
      new DocsAPI.DocEditor('editor', config);
    }})();
  </script>
</body>
</html>"""
        return HttpResponse(html, content_type='text/html')

    @action(detail=True, methods=['post'], url_path='onlyoffice-callback',
            permission_classes=[permissions.AllowAny], authentication_classes=[])
    def onlyoffice_callback(self, request, pk=None):
        """OnlyOffice calls this endpoint when the document is saved."""
        import jwt
        import urllib.request

        secret = getattr(settings, 'ONLYOFFICE_JWT_SECRET', '')

        if secret:
            # OnlyOffice normally includes the callback JWT in the POST body
            # as `token`. Prefer that value to avoid DRF/SimpleJWT attempting
            # to authenticate using other Bearer tokens in the Authorization
            # header (which are unrelated and may cause 401s).
            token = request.data.get('token', '') or ''
            if not token:
                auth_header = request.headers.get('Authorization', '')
                if auth_header.startswith('Bearer '):
                    token = auth_header[7:]
            if token:
                try:
                    jwt.decode(token, secret, algorithms=['HS256'])
                except Exception:
                    return Response({'error': 1}, status=403)
            else:
                return Response({'error': 1}, status=403)

        body = request.data
        oo_status = body.get('status')
        if oo_status in (2, 6):
            download_url = body.get('url', '')
            if download_url:
                doc = Document.objects.filter(pk=pk).first()
                if doc:
                    try:
                        with urllib.request.urlopen(download_url, timeout=30) as resp:
                            content = resp.read()
                        fname = doc.file.name.rsplit('/', 1)[-1]
                        doc.file.save(fname, ContentFile(content), save=False)
                        doc.version += 1
                        doc.save(update_fields=['file', 'version'])
                    except Exception:
                        return Response({'error': 1})

        return Response({'error': 0})

    @action(detail=True, methods=['post'])
    def process_ai(self, request, pk=None):
        """Queue async AI text extraction + summarisation for this document."""
        document = self.get_object()

        from apps.ai_assistant.tasks import process_document_ai
        from apps.ai_assistant.models import AITask

        # Reset flag so task re-runs even if already processed
        document.ai_processed = False
        document.save(update_fields=['ai_processed'])

        task = AITask.objects.create(
            task_type=AITask.PDF_EXTRACTION,
            requested_by=request.user,
            input_data={'document_id': document.id},
        )
        process_document_ai.delay(task.id)
        return Response({'task_id': task.id, 'detail': 'AI processing queued.'})

    @action(detail=False, methods=['post'], url_path='create-blank',
            permission_classes=[permissions.IsAuthenticated])
    def create_blank(self, request):
        """
        POST /api/documents/create-blank/
        Create a blank Word/Excel/PowerPoint document and return its doc_id for
        immediate opening in OnlyOffice.

        Body: { folder: <int>, title: <str>, doc_type: 'docx'|'xlsx'|'pptx' }
        """
        import io
        from apps.survey_projects.models import ProjectLayerFolder, SurveyProject

        folder_id = request.data.get('folder')
        title = (request.data.get('title') or 'New Document').strip()
        doc_type = request.data.get('doc_type', 'docx').lower()
        if doc_type not in ('docx', 'xlsx', 'pptx'):
            doc_type = 'docx'

        folder = None
        project = None
        if folder_id:
            try:
                folder = ProjectLayerFolder.objects.select_related('project').get(pk=folder_id)
                project = folder.project
            except ProjectLayerFolder.DoesNotExist:
                return Response({'detail': 'Folder not found.'}, status=404)

        buf = io.BytesIO()
        try:
            if doc_type == 'docx':
                from docx import Document as DocxDoc
                d = DocxDoc()
                d.add_heading(title, level=0)
                d.add_paragraph('')
                d.save(buf)
            elif doc_type == 'xlsx':
                import openpyxl
                wb = openpyxl.Workbook()
                wb.active.title = 'Sheet1'
                wb.save(buf)
            elif doc_type == 'pptx':
                from pptx import Presentation
                from pptx.util import Inches, Pt
                prs = Presentation()
                slide = prs.slides.add_slide(prs.slide_layouts[0])
                slide.shapes.title.text = title
                prs.save(buf)
        except ImportError as e:
            return Response({'detail': f'Required library not installed: {e}'}, status=500)

        buf.seek(0)
        safe = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in title)
        filename = f'{safe[:60]}.{doc_type}'

        doc = Document(
            project=project,
            folder=folder,
            title=title,
            category='REPORT',
            uploaded_by=request.user,
        )
        doc.file.save(filename, ContentFile(buf.read()), save=True)

        return Response({'doc_id': doc.id, 'title': doc.title}, status=201)
