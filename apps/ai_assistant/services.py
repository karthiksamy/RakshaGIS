import json
import httpx
from django.conf import settings


def _resolve_ollama_url() -> str:
    """Return local Ollama URL if reachable, otherwise fall back to Docker service URL."""
    local = getattr(settings, 'OLLAMA_LOCAL_URL', 'http://localhost:11434')
    try:
        resp = httpx.get(f"{local}/api/tags", timeout=2)
        if resp.status_code == 200:
            return local
    except Exception:
        pass
    return getattr(settings, 'OLLAMA_DOCKER_URL', settings.OLLAMA_BASE_URL)


class OllamaService:
    def __init__(self):
        self.base_url = _resolve_ollama_url()
        self.model = settings.OLLAMA_MODEL
        self.timeout = 120

    def _post(self, endpoint: str, payload: dict) -> dict:
        response = httpx.post(
            f"{self.base_url}{endpoint}",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def chat(self, messages: list[dict]) -> str:
        data = self._post('/api/chat', {
            'model': self.model,
            'messages': messages,
            'stream': False,
        })
        return data['message']['content']

    def generate(self, prompt: str, system: str = '') -> str:
        payload = {'model': self.model, 'prompt': prompt, 'stream': False}
        if system:
            payload['system'] = system
        data = self._post('/api/generate', payload)
        return data['response']

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
            "Answer questions about survey projects, land records, and spatial data. "
            "If asked to query data, suggest the relevant filter parameters for the API."
        )
        prompt = question if not context else f"Context:\n{context}\n\nQuestion: {question}"
        return self.generate(prompt=prompt, system=system)

    def validate_attributes(self, attributes: dict, layer_name: str) -> str:
        return self.generate(
            prompt=f"Validate these GIS feature attributes for a '{layer_name}' layer:\n\n{json.dumps(attributes, indent=2)}\n\nList any missing fields, inconsistencies, or data quality issues.",
            system="You are a GIS data quality expert for Indian land survey systems.",
        )

    def is_available(self) -> bool:
        try:
            resp = httpx.get(f"{self.base_url}/api/tags", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False
