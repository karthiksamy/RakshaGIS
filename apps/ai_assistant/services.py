import json
import math
import httpx
from django.conf import settings

_EMBED_ONLY_FAMILIES = {'bert', 'nomic-bert'}


# ── URL probing helpers ────────────────────────────────────────────────────────

def _probe_url(url: str, timeout: float = 2.0, api_key: str = '') -> bool:
    headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    try:
        r = httpx.get(f"{url}/api/tags", timeout=timeout, headers=headers)
        if r.status_code == 200:
            return True
    except Exception:
        pass
    # OpenAI-compat: try /v1/models
    try:
        r = httpx.get(f"{url}/v1/models", timeout=timeout, headers=headers)
        return r.status_code in (200, 401)  # 401 = reachable but auth needed
    except Exception:
        return False


def _list_ollama_chat_models(url: str) -> list[str]:
    try:
        r = httpx.get(f"{url}/api/tags", timeout=3)
        r.raise_for_status()
        result = []
        for m in r.json().get('models', []):
            families = m.get('details', {}).get('families') or []
            if any(f in _EMBED_ONLY_FAMILIES for f in families):
                continue
            result.append(m['name'])
        return result
    except Exception:
        return []


def _auto_resolve_ollama() -> tuple[str, str]:
    """Try env-configured URLs in order; return first reachable (url, model)."""
    configured_model = getattr(settings, 'OLLAMA_MODEL', 'llama3.2')
    candidates = [
        getattr(settings, 'OLLAMA_LOCAL_URL',  'http://localhost:11434'),
        getattr(settings, 'OLLAMA_HOST_URL',   'http://host.docker.internal:11434'),
        getattr(settings, 'OLLAMA_DOCKER_URL', 'http://ollama:11434'),
        getattr(settings, 'OLLAMA_BASE_URL',   'http://ollama:11434'),
    ]
    seen, unique = set(), []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            unique.append(c)

    for url in unique:
        chat_models = _list_ollama_chat_models(url)
        if not chat_models:
            continue
        def _match(name: str) -> bool:
            return name == configured_model or name.startswith(configured_model + ':')
        model = next((m for m in chat_models if _match(m)), None) or chat_models[0]
        return url, model

    return unique[0], configured_model


# ── Main service ───────────────────────────────────────────────────────────────

class LLMService:
    """
    Unified LLM service.  Reads the active LLMConfig from DB; falls back to
    env-based Ollama auto-detection when no DB config is active.
    """

    def __init__(self):
        self._load_config()

    def _load_config(self):
        try:
            from apps.ai_assistant.models import LLMConfig
            cfg = LLMConfig.objects.filter(is_active=True).order_by('-updated_at').first()
        except Exception:
            cfg = None

        if cfg:
            self.provider  = cfg.provider
            self.base_url  = cfg.base_url.rstrip('/')
            self.model     = cfg.model_name
            self.api_key   = cfg.api_key or ''
            self.timeout   = cfg.timeout
        else:
            # No DB config — auto-detect local Ollama
            from apps.ai_assistant.models import LLMConfig as _LC
            url, model = _auto_resolve_ollama()
            self.provider  = _LC.OLLAMA
            self.base_url  = url
            self.model     = model
            self.api_key   = ''
            self.timeout   = 120

    # ── Internal HTTP ─────────────────────────────────────────────────────────

    def _headers(self) -> dict:
        h = {'Content-Type': 'application/json'}
        if self.api_key:
            h['Authorization'] = f'Bearer {self.api_key}'
        return h

    def _post_ollama_chat(self, messages: list[dict]) -> str:
        r = httpx.post(
            f"{self.base_url}/api/chat",
            json={'model': self.model, 'messages': messages, 'stream': False},
            headers=self._headers(),
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()['message']['content']

    def _post_ollama_generate(self, prompt: str, system: str) -> str:
        payload: dict = {'model': self.model, 'prompt': prompt, 'stream': False}
        if system:
            payload['system'] = system
        r = httpx.post(
            f"{self.base_url}/api/generate",
            json=payload,
            headers=self._headers(),
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()['response']

    def _post_openai_chat(self, messages: list[dict]) -> str:
        r = httpx.post(
            f"{self.base_url}/v1/chat/completions",
            json={'model': self.model, 'messages': messages, 'stream': False},
            headers=self._headers(),
            timeout=self.timeout,
        )
        r.raise_for_status()
        data = r.json()
        return data['choices'][0]['message']['content']

    def _post_hf(self, messages: list[dict]) -> str:
        """HuggingFace Inference API (text-generation task or chat endpoint)."""
        # Try the newer /v1/chat/completions endpoint first (HF Inference Endpoints)
        try:
            r = httpx.post(
                f"{self.base_url}/v1/chat/completions",
                json={'model': self.model, 'messages': messages, 'stream': False},
                headers=self._headers(),
                timeout=self.timeout,
            )
            r.raise_for_status()
            return r.json()['choices'][0]['message']['content']
        except Exception:
            pass
        # Fall back to legacy text-generation pipeline
        prompt = '\n'.join(f"{m['role'].upper()}: {m['content']}" for m in messages)
        r = httpx.post(
            f"{self.base_url}",
            json={'inputs': prompt, 'parameters': {'max_new_tokens': 512}},
            headers=self._headers(),
            timeout=self.timeout,
        )
        r.raise_for_status()
        result = r.json()
        if isinstance(result, list):
            return result[0].get('generated_text', '')
        return result.get('generated_text', str(result))

    # ── Public API ────────────────────────────────────────────────────────────

    def chat(self, messages: list[dict]) -> str:
        from apps.ai_assistant.models import LLMConfig as _LC
        if self.provider == _LC.OLLAMA:
            return self._post_ollama_chat(messages)
        elif self.provider == _LC.HUGGINGFACE:
            return self._post_hf(messages)
        else:
            return self._post_openai_chat(messages)

    def generate(self, prompt: str, system: str = '') -> str:
        from apps.ai_assistant.models import LLMConfig as _LC
        if self.provider == _LC.OLLAMA:
            return self._post_ollama_generate(prompt, system)
        else:
            messages = []
            if system:
                messages.append({'role': 'system', 'content': system})
            messages.append({'role': 'user', 'content': prompt})
            return self.chat(messages)

    def is_available(self) -> bool:
        return _probe_url(self.base_url, timeout=5, api_key=self.api_key)

    def list_models(self) -> list[str]:
        """Return available model names from the configured endpoint."""
        from apps.ai_assistant.models import LLMConfig as _LC
        if self.provider == _LC.OLLAMA:
            return _list_ollama_chat_models(self.base_url)
        try:
            r = httpx.get(
                f"{self.base_url}/v1/models",
                headers=self._headers(),
                timeout=5,
            )
            r.raise_for_status()
            return [m['id'] for m in r.json().get('data', [])]
        except Exception:
            return []

    # ── Convenience wrappers ──────────────────────────────────────────────────

    def summarize_document(self, text: str) -> str:
        return self.generate(
            prompt=f"Summarize this government land survey document concisely:\n\n{text[:4000]}",
            system=(
                "You are a GIS and land survey expert assistant for DGDE (India). "
                "Summarize documents accurately, extracting key facts such as survey numbers, "
                "area measurements, ownership details, and any discrepancies."
            ),
        )

    def generate_inspection_report(self, project_data: dict) -> str:
        return self.generate(
            prompt=f"Generate a formal inspection report based on this survey project data:\n\n{json.dumps(project_data, indent=2)}",
            system=(
                "You are drafting official inspection reports for the Indian Defence Estates department (DGDE). "
                "Use formal government report language. Include sections for project details, findings, "
                "observations, and recommendations."
            ),
        )

    def answer_gis_question(self, question: str, context: str = '') -> str:
        system = (
            "You are a GIS assistant for DGDE RakshaGIS platform. "
            "Answer questions about survey projects, land records, and spatial data."
        )
        prompt = question if not context else f"Context:\n{context}\n\nQuestion: {question}"
        return self.generate(prompt=prompt, system=system)

    def validate_attributes(self, attributes: dict, layer_name: str) -> str:
        return self.generate(
            prompt=f"Validate these GIS feature attributes for a '{layer_name}' layer:\n\n{json.dumps(attributes, indent=2)}\n\nList any missing fields, inconsistencies, or data quality issues.",
            system="You are a GIS data quality expert for Indian land survey systems.",
        )

    # ── Embedding (RAG) ──────────────────────────────────────────────────────

    def get_embedding(self, text: str, model: str = 'nomic-embed-text') -> list[float]:
        """Call Ollama /api/embed and return the embedding vector."""
        r = httpx.post(
            f"{self.base_url}/api/embed",
            json={'model': model, 'input': text},
            timeout=60,
        )
        r.raise_for_status()
        data = r.json()
        # Ollama returns {"embeddings": [[...]], ...} in newer versions
        if 'embeddings' in data:
            return data['embeddings'][0]
        # Older: {"embedding": [...]}
        return data.get('embedding', [])

    def list_embed_models(self) -> list[str]:
        """Return models that are embed-only (bert family) from Ollama."""
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=3)
            r.raise_for_status()
            result = []
            for m in r.json().get('models', []):
                families = m.get('details', {}).get('families') or []
                if any(f in _EMBED_ONLY_FAMILIES for f in families):
                    result.append(m['name'])
            return result
        except Exception:
            return []

    # ── Vision ───────────────────────────────────────────────────────────────

    def vision_analyze(self, image_b64: str, prompt: str, model: str = 'llava:7b') -> str:
        """Send an image (base64) + prompt to a vision-capable Ollama model."""
        r = httpx.post(
            f"{self.base_url}/api/chat",
            json={
                'model': model,
                'messages': [
                    {
                        'role': 'user',
                        'content': prompt,
                        'images': [image_b64],
                    }
                ],
                'stream': False,
            },
            timeout=300,  # Vision models are slow
        )
        if r.status_code == 404:
            # Ollama returns 404 when the model is not installed
            err_msg = r.json().get('error', '') if r.headers.get('content-type', '').startswith('application/json') else ''
            raise RuntimeError(
                f"Vision model '{model}' not found in Ollama. "
                f"Pull it first: ollama pull {model}  "
                f"({'Ollama says: ' + err_msg if err_msg else 'Model not installed'})"
            )
        r.raise_for_status()
        return r.json()['message']['content']

    def list_vision_models(self) -> list[str]:
        """Return models that support vision (have 'clip' or 'vision' in their details)."""
        try:
            r = httpx.get(f"{self.base_url}/api/tags", timeout=3)
            r.raise_for_status()
            result = []
            for m in r.json().get('models', []):
                name = m.get('name', '')
                families = m.get('details', {}).get('families') or []
                # Vision models include llava, moondream, qwen-vl, minicpm-v, etc.
                if any(f in name.lower() for f in ('llava', 'moondream', 'minicpm', 'qwen2-vl', 'vision', 'bakllava')):
                    result.append(name)
                elif 'clip' in families:
                    result.append(name)
            return result
        except Exception:
            return []

    # ── RAG context retrieval ─────────────────────────────────────────────────

    def answer_with_rag(self, question: str, project_id: int, top_k: int = 5) -> tuple[str, list[dict]]:
        """
        Retrieve the top_k most relevant document chunks for `question`
        from the given project, inject them as context, and return
        (answer, list_of_source_chunks).
        """
        from apps.ai_assistant.models import DocumentChunk

        chunks = list(
            DocumentChunk.objects.filter(project_id=project_id)
            .exclude(embedding=[])
            .values('id', 'text', 'embedding', 'document__title', 'chunk_index')
        )

        if not chunks:
            # No embeddings yet — fall back to plain answer
            answer = self.answer_gis_question(question)
            return answer, []

        # Embed the question using the same model as the chunks
        embed_model = chunks[0].get('embed_model', 'nomic-embed-text') if chunks else 'nomic-embed-text'
        # embed_model is not in .values() above — get it separately
        em_record = DocumentChunk.objects.filter(project_id=project_id).exclude(embedding=[]).first()
        embed_model = em_record.embed_model if em_record else 'nomic-embed-text'

        try:
            q_embedding = self.get_embedding(question, model=embed_model)
        except Exception:
            answer = self.answer_gis_question(question)
            return answer, []

        # Compute cosine similarity for each chunk
        scored = []
        for chunk in chunks:
            sim = _cosine_similarity(q_embedding, chunk['embedding'])
            scored.append((sim, chunk))

        scored.sort(key=lambda x: x[0], reverse=True)
        top_chunks = [c for _, c in scored[:top_k]]

        # Build context string
        context_parts = []
        for c in top_chunks:
            context_parts.append(
                f"[Source: {c['document__title']}, chunk {c['chunk_index']}]\n{c['text']}"
            )
        context = '\n\n---\n\n'.join(context_parts)

        system = (
            "You are DGDE-Expert, an AI assistant for the Directorate General of Defence Estates, India. "
            "You have deep knowledge of Indian land survey law, defence estate management, and GIS workflows. "
            "Answer questions accurately based on the provided document context. "
            "If the context does not contain the answer, say so clearly."
        )
        prompt = f"Context from project documents:\n\n{context}\n\n---\n\nQuestion: {question}"

        answer = self.generate(prompt=prompt, system=system)

        sources = [
            {'chunk_id': c['id'], 'doc_title': c['document__title'], 'chunk_index': c['chunk_index']}
            for c in top_chunks
        ]
        return answer, sources


# ── Pure-Python helpers ────────────────────────────────────────────────────────

def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot  = sum(x * y for x, y in zip(a, b))
    na   = math.sqrt(sum(x * x for x in a))
    nb   = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def chunk_text(text: str, chunk_size: int = 600, overlap: int = 80) -> list[str]:
    """
    Split `text` into overlapping word-level chunks.
    chunk_size / overlap are in words (not characters).
    """
    words = text.split()
    if not words:
        return []
    chunks = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunks.append(' '.join(words[start:end]))
        if end == len(words):
            break
        start += chunk_size - overlap
    return chunks


DGDE_SYSTEM_PROMPT = """\
You are DGDE-Expert, an AI assistant embedded in RakshaGIS — the official GIS survey \
management platform for the Directorate General of Defence Estates (DGDE), Government of India.

Domain knowledge:
- Land Acquisition Act 1894 / RFCTLARR Act 2013, Defence Lands and Cantonments Act 2006
- Survey of India standards (cadastral, topographic, revenue surveys)
- Indian coordinate reference systems: Everest 1830 (SOI local), WGS 84
- DGDE org hierarchy: DGDE → PDDE → DEO → CEO/ADEO offices
- Survey workflow roles: Surveyor/SDO → Checker → Approver → DEO Admin
- Key document types: mutation record, survey settlement, revenue map, demarcation notice,
  boundary pillars report, encroachment report, defence land register
- GIS terms: cadastral parcel, khasra/khata, survey number, topo sheet, SFD (Standard Format Drawing)

Behaviour:
- Always refer to parcels by their survey number if available
- Use formal government report language for generated reports
- Cross-reference information across documents when possible
- Flag discrepancies between document text and GIS data if noticed
- Never speculate about land ownership; cite the source document
"""


# Keep OllamaService as an alias so existing code that imports it still works
OllamaService = LLMService
