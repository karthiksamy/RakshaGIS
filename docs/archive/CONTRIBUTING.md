# Contributing to RakshaGIS

Thank you for contributing to RakshaGIS! This document outlines the development workflow and coding standards.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Development Environment Setup](#development-environment-setup)
3. [Code Style & Standards](#code-style--standards)
4. [Testing](#testing)
5. [Git Workflow](#git-workflow)
6. [Pull Request Process](#pull-request-process)
7. [Common Tasks](#common-tasks)

---

## Getting Started

### Prerequisites

- **Python 3.11+** (with venv support)
- **Node.js 18+** and npm
- **Docker & Docker Compose v2.20+**
- **Git**

### Fork & Clone

```bash
git clone <your-fork-url> RakshaGIS
cd RakshaGIS
```

---

## Development Environment Setup

### Backend (Django)

```bash
# 1. Start only backend services (no frontend dev server)
docker compose up -d db redis pg_tileserv

# 2. Create and activate Python virtualenv
python3.11 -m venv venv
source venv/bin/activate

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Set up environment
cp .env.example .env
# Edit .env: set DATABASE_URL, REDIS_URL (point to localhost, not docker services)
export DATABASE_URL=postgres://raksha:yourpassword@localhost:5432/rakshagis
export DJANGO_SETTINGS_MODULE=config.settings.development

# 5. Create migrations (if you added new models)
python manage.py makemigrations

# 6. Run migrations
python manage.py migrate

# 7. Create superuser (for local testing)
python manage.py createsuperuser

# 8. Seed basemaps
python manage.py seed_basemaps

# 8. Start Django dev server
python manage.py runserver 0.0.0.0:8000
```

### Celery Worker (Async Tasks)

In a separate terminal:

```bash
source venv/bin/activate
celery -A config worker --loglevel=info
```

### Frontend (React + Vite)

In a third terminal:

```bash
cd frontend
npm install
npm run dev
```

Frontend dev server runs at `http://localhost:5173` with API proxied to `http://localhost:8000`.

### Access Points

| Service | URL |
|---|---|
| Backend | `http://localhost:8000` |
| Frontend (dev) | `http://localhost:5173` |
| API Docs | `http://localhost:8000/api/schema/swagger-ui/` |
| PostgreSQL | `localhost:5432` (use `psql` client) |
| Redis | `localhost:6379` (use `redis-cli`) |

---

## Code Style & Standards

### Python

- **Formatter**: Black
- **Linter**: Flake8
- **Type hints**: Use type hints on function signatures (PEP 484)
- **Docstrings**: Use minimal single-line docstrings; only multi-line if the WHY is non-obvious
- **Imports**: Alphabetical, grouped (stdlib, third-party, local)

```bash
# Format backend code
black apps/ config/

# Check linting
flake8 apps/ config/
```

### Django Models & Serializers

- Use descriptive field names (e.g., `created_at` not `ctime`)
- Add `Meta.ordering` for consistent list order
- Add `help_text` for complex fields
- Serializer fields should mirror model fields; use `source=` only when necessary
- Use `read_only_fields` for auto-generated fields

### Django Views & Viewsets

- Use DRF viewsets; avoid bare APIView unless necessary
- Add `permission_classes` to every viewset
- Use `select_related()` and `prefetch_related()` to avoid N+1 queries
- Use `@action(detail=...)` for non-standard endpoints
- Add docstrings to custom actions

### Django REST Framework

```python
# Good
class ProjectViewSet(viewsets.ModelViewSet):
    queryset = SurveyProject.objects.select_related('organisation').all()
    permission_classes = [IsAuthenticated]
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ['organisation', 'status']
    search_fields = ['project_number', 'name']
    ordering_fields = ['created_at', 'name']

    @action(detail=True, methods=['post'])
    def publish(self, request, pk=None):
        """Publish a project (SuperAdmin only)."""
        if not request.user.is_superadmin:
            return Response(status=403)
        # ...
```

### Frontend (TypeScript + React)

- **Formatter**: Prettier (configured in `.prettierrc`)
- **Linter**: ESLint
- **Type safety**: Strict TypeScript (`strict: true`)
- **Component naming**: PascalCase, one component per file
- **Hooks**: `use*` naming convention
- **Props interfaces**: Define explicit interface per component

```typescript
// Good component structure
interface ProjectListProps {
  organisationId: number
  onSelect: (id: number) => void
}

export default function ProjectList({ organisationId, onSelect }: ProjectListProps) {
  const { data } = useQuery(...)
  
  return (...)
}
```

### Avoid

- Overly clever one-liners; readability first
- Magic numbers; use named constants
- Deeply nested ternaries; use if/else or early returns
- Unused variables or imports (linters catch these)
- Comments that explain WHAT the code does (the code itself should be clear)
- Comments that repeat the code (e.g., `// increment counter` above `count++`)

### Good comments explain WHY

```typescript
// Track which survey areas have been invalidated by boundary disputes
// (used to invalidate the map feature cache without a full refetch)
const invalidatedAreas = new Set<number>()
```

---

## Testing

### Backend Tests

```bash
source venv/bin/activate

# Run all tests
python manage.py test

# Run a specific app
python manage.py test apps.survey_projects

# Run a specific test class
python manage.py test apps.survey_projects.tests.ProjectTests

# Run with coverage
coverage run --source='.' manage.py test
coverage report
```

### Frontend Tests

```bash
cd frontend

# Run unit tests (Vitest)
npm run test

# Run with coverage
npm run test:coverage

# E2E tests (if added)
npm run test:e2e
```

### Writing Tests

**Backend (Python)**

```python
from django.test import TestCase
from apps.survey_projects.models import SurveyProject

class ProjectTests(TestCase):
    def setUp(self):
        self.org = Organisation.objects.create(...)
        self.project = SurveyProject.objects.create(organisation=self.org, ...)
    
    def test_project_creation(self):
        """Project creation with valid data succeeds."""
        self.assertEqual(SurveyProject.objects.count(), 1)
        self.assertEqual(self.project.status, 'DRAFT')
```

**Frontend (TypeScript)**

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProjectList from './ProjectList'

describe('ProjectList', () => {
  it('renders project names', () => {
    render(<ProjectList projects={[{ id: 1, name: 'Test' }]} />)
    expect(screen.getByText('Test')).toBeInTheDocument()
  })
})
```

---

## Git Workflow

### Branch Naming

- Feature: `feature/short-description` (e.g., `feature/ai-chat-rag`)
- Fix: `fix/short-description` (e.g., `fix/websocket-reconnect`)
- Refactor: `refactor/short-description`
- Docs: `docs/short-description`

### Commit Messages

Use the commit template:

```
<type>: <subject>

<body (optional)>

<footer (optional)>
```

**Types**: feat, fix, docs, style, refactor, perf, test, chore

**Examples**

```
feat: add RAG embedding to AI chat endpoint

When a project is selected in the chat UI, document chunks are now
retrieved via cosine similarity and injected as context.

Relates to: #42
```

```
fix: prevent WebSocket reconnect loop on auth failure

Previously, if JWT token was invalid, the client would infinitely
retry the connection every 3 seconds. Now it closes cleanly.
```

### Before You Commit

```bash
# Backend
black apps/ config/
flake8 apps/ config/
python manage.py test

# Frontend
cd frontend && npm run lint && npm run test
```

---

## Pull Request Process

### 1. Keep PRs Focused

- One feature or fix per PR
- If changes span multiple concerns, split into separate PRs
- Aim for <400 lines of changes per PR (easier to review)

### 2. Write a Clear PR Description

```markdown
## Summary
Brief 1-3 sentence description of what changed and why.

## Changes
- Bullet list of specific changes
- One per line

## Testing
How did you test this? Include steps to reproduce.

## Screenshots (if UI changes)
Include before/after screenshots for UI changes.

## Checklist
- [ ] Tests added/updated
- [ ] Docs updated (README, API docs, etc.)
- [ ] No breaking changes to API
- [ ] Migrations included (if schema changed)
```

### 3. Link Related Issues

```markdown
Closes #42
Relates to #40, #41
```

### 4. Respond to Review Comments

- Address all comments or ask for clarification
- Push new commits (don't rebase if PR is already under review)
- Mark conversations as resolved after addressing

### 5. Pass CI Checks

- All tests must pass
- Code review approval required (≥1 maintainer)
- No conflicts with base branch

---

## Common Tasks

### Adding a New Django Model

```python
# 1. Create in apps/*/models.py
class MyModel(models.Model):
    name = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        ordering = ['name']
    
    def __str__(self):
        return self.name

# 2. Create serializer in apps/*/serializers.py
class MyModelSerializer(serializers.ModelSerializer):
    class Meta:
        model = MyModel
        fields = ['id', 'name', 'created_at']

# 3. Create viewset in apps/*/views.py
class MyModelViewSet(viewsets.ModelViewSet):
    queryset = MyModel.objects.all()
    serializer_class = MyModelSerializer
    permission_classes = [IsAuthenticated]

# 4. Register in apps/*/urls.py
router.register('my-models', MyModelViewSet)

# 5. Create migration (must be done on the host, not in Docker)
python manage.py makemigrations

# 6. Commit the migration files
git add apps/*/migrations/000X_*.py
git commit -m "feat: add MyModel to apps.your_app"

# 7. Test
python manage.py test apps.your_app.tests.MyModelTests

# Note: Always commit migration files to git. When others run ./build.sh,
# migrations will be automatically applied from the committed files.
```

### Adding a New React Component

```typescript
// components/MyComponent.tsx
import { Button } from 'antd'

interface MyComponentProps {
  title: string
  onAction: () => void
}

export default function MyComponent({ title, onAction }: MyComponentProps) {
  return <Button onClick={onAction}>{title}</Button>
}
```

### Adding a New API Endpoint

```python
# In your viewset, add an @action
@action(detail=False, methods=['post'])
def custom_endpoint(self, request):
    """Custom endpoint description."""
    data = request.data
    # ... logic ...
    return Response({'result': 'success'})

# This creates: POST /api/path/custom-endpoint/
```

### Running Management Commands

```bash
# During development (from venv)
python manage.py <command>

# In Docker
docker compose run --rm web python manage.py <command>
```

### Checking Database State

```bash
# Connect to PostgreSQL
docker compose exec db psql -U raksha -d rakshagis

# View schema
\dt                  # list tables
\d apps_surveyarea   # describe table
SELECT * FROM auth_user;
```

### Debugging WebSocket Issues

```bash
# Check Daphne is running
docker compose logs web | grep Daphne

# Check Redis channel layer
docker compose exec web python manage.py shell -c "
from channels.layers import get_channel_layer
import asyncio
cl = get_channel_layer()
asyncio.run(cl.group_add('test', 'ch'))
print('OK')
"

# Monitor WebSocket messages (browser console)
// In MapPage.tsx or any WebSocket component:
console.log('WS message:', event)
```

---

## Resources

- [Django REST Framework Docs](https://www.django-rest-framework.org/)
- [React Docs](https://react.dev)
- [Ant Design Component Library](https://ant.design/)
- [PostGIS Documentation](https://postgis.net/documentation/)
- [Celery Task Queue](https://docs.celeryproject.io/)
- [Django Channels Documentation](https://channels.readthedocs.io/)

---

## Questions?

- Open an issue on GitHub
- Check existing issues / discussions
- Reach out to the maintainers

Thank you for contributing! 🙏
