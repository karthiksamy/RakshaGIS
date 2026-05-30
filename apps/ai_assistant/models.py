from django.db import models
from django.conf import settings


class LLMConfig(models.Model):
    """Active LLM backend configuration — only one record should be active at a time."""

    OLLAMA        = 'ollama'
    OPENAI_COMPAT = 'openai_compat'   # LocalAI / LlamaCpp / LM Studio / AnythingLLM / HF endpoint
    HUGGINGFACE   = 'huggingface'

    PROVIDER_CHOICES = [
        (OLLAMA,        'Ollama'),
        (OPENAI_COMPAT, 'OpenAI-Compatible (LocalAI / LM Studio / LlamaCpp / AnythingLLM)'),
        (HUGGINGFACE,   'HuggingFace Inference API'),
    ]

    name       = models.CharField(max_length=100, help_text='Friendly label, e.g. "Local llama3.2"')
    provider   = models.CharField(max_length=20, choices=PROVIDER_CHOICES, default=OLLAMA)
    base_url   = models.CharField(max_length=300, help_text='e.g. http://host.docker.internal:11434')
    model_name = models.CharField(max_length=200, help_text='e.g. llama3.2 or meta-llama/Llama-2-7b-chat-hf')
    api_key    = models.CharField(max_length=500, blank=True,
                     help_text='API key / Bearer token (leave blank for local servers)')
    timeout    = models.PositiveIntegerField(default=120, help_text='Request timeout in seconds')
    is_active  = models.BooleanField(default=False)
    notes      = models.TextField(blank=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='llm_configs',
    )
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-is_active', '-updated_at']
        verbose_name = 'LLM Configuration'

    def __str__(self):
        active = ' [ACTIVE]' if self.is_active else ''
        return f"{self.name} ({self.provider}){active}"


class ChatSession(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='chat_sessions'
    )
    title = models.CharField(max_length=200, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return f"Chat {self.id} — {self.user}"


class ChatMessage(models.Model):
    USER = 'USER'
    ASSISTANT = 'ASSISTANT'

    ROLE_CHOICES = [
        (USER, 'User'),
        (ASSISTANT, 'Assistant'),
    ]

    session = models.ForeignKey(ChatSession, on_delete=models.CASCADE, related_name='messages')
    role = models.CharField(max_length=10, choices=ROLE_CHOICES)
    content = models.TextField()
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"[{self.role}] {self.content[:60]}"


class AITask(models.Model):
    PENDING = 'PENDING'
    RUNNING = 'RUNNING'
    DONE = 'DONE'
    FAILED = 'FAILED'

    STATUS_CHOICES = [
        (PENDING, 'Pending'),
        (RUNNING, 'Running'),
        (DONE, 'Done'),
        (FAILED, 'Failed'),
    ]

    REPORT_GENERATION = 'REPORT_GENERATION'
    PDF_EXTRACTION = 'PDF_EXTRACTION'
    ATTRIBUTE_VALIDATION = 'ATTRIBUTE_VALIDATION'
    GIS_INDEXING = 'GIS_INDEXING'
    MODEL_PULL = 'MODEL_PULL'

    DOCUMENT_EMBEDDING  = 'DOCUMENT_EMBEDDING'
    BOUNDARY_EXTRACTION = 'BOUNDARY_EXTRACTION'
    TRAINING_EXPORT     = 'TRAINING_EXPORT'

    TASK_TYPE_CHOICES = [
        (REPORT_GENERATION,  'Report Generation'),
        (PDF_EXTRACTION,     'PDF Text Extraction & Summary'),
        (ATTRIBUTE_VALIDATION, 'Attribute Validation'),
        (GIS_INDEXING,       'GIS File Indexing'),
        (MODEL_PULL,         'Model Pull / Download'),
        (DOCUMENT_EMBEDDING, 'Document Embedding (RAG)'),
        (BOUNDARY_EXTRACTION,'Boundary Extraction from Scanned Map'),
        (TRAINING_EXPORT,    'Training Dataset Export'),
    ]

    task_type = models.CharField(max_length=30, choices=TASK_TYPE_CHOICES)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='ai_tasks'
    )
    input_data = models.JSONField(default=dict)
    result = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.get_task_type_display()} — {self.status}"


class DocumentChunk(models.Model):
    """
    One chunk of text extracted from a Document, with its embedding vector.
    Used by the RAG pipeline to provide context-aware answers.
    """
    document   = models.ForeignKey(
        'documents.Document', on_delete=models.CASCADE, related_name='chunks'
    )
    project    = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.CASCADE,
        related_name='doc_chunks', null=True, blank=True,
    )
    chunk_index = models.PositiveIntegerField(default=0)
    text        = models.TextField()
    # Embedding stored as a JSON list of floats. Dimension depends on model
    # (768 for nomic-embed-text, 1024 for mxbai-embed-large, etc.)
    embedding   = models.JSONField(default=list)
    embed_model = models.CharField(max_length=100, default='nomic-embed-text')
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['document', 'chunk_index']
        unique_together = [('document', 'chunk_index')]

    def __str__(self):
        return f'Chunk {self.chunk_index} of doc {self.document_id}'


class BoundaryExtractionJob(models.Model):
    """Tracks a vision-model run that extracts parcel boundaries from a scanned map image."""
    PENDING  = 'PENDING'
    RUNNING  = 'RUNNING'
    DONE     = 'DONE'
    FAILED   = 'FAILED'
    STATUS_CHOICES = [(s, s) for s in (PENDING, RUNNING, DONE, FAILED)]

    # Source image — can be an uploaded document or a raw file field
    source_document = models.ForeignKey(
        'documents.Document', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='boundary_extractions',
        help_text='Existing document record containing the scanned map image.',
    )
    source_image = models.ImageField(
        upload_to='boundary_extraction/', null=True, blank=True,
        help_text='Directly uploaded scanned map image.',
    )
    project  = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.CASCADE,
        related_name='boundary_extractions',
    )
    vision_model = models.CharField(max_length=100, default='llava:7b')
    status   = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)
    # Raw text response from the vision model
    raw_response = models.TextField(blank=True)
    # Parsed result: map_info dict + parcels list
    parsed_result = models.JSONField(null=True, blank=True)
    # GIS features created from this extraction (JSON: list of GeoJSON features)
    draft_features = models.JSONField(default=list)
    error_log    = models.TextField(blank=True)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+'
    )
    created_at   = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'BoundaryExtraction({self.project_id}, {self.status})'
