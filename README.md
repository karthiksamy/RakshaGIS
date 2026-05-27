# RakshaGIS — Defence Estate GIS Survey Platform

**A full-stack, self-hosted Geographic Information System for the Directorate General of Defence Estates (DGDE), Government of India.**

---

## Overview

RakshaGIS is an enterprise-grade web GIS platform purpose-built for the DGDE to digitise, manage, and publish defence land surveys. It replaces paper-based and siloed workflows with a single, role-gated system that covers field surveying, survey-area-wise internal review and approval routing, AI-assisted document processing, and public-facing layer publishing — all hosted on-premise with no dependency on commercial cloud services.

---

## Key Features

### Map & Spatial Analysis
- Interactive map built on OpenLayers 10 with multi-basemap support (OSM, XYZ, WMS/WMTS, Bhuvan)
- Draw and edit Point, Line, and Polygon features with snapping and live area/perimeter feedback
- Edit existing features (move vertices) with automatic backend sync
- Box-select and identify tools
- Buffer analysis: N configurable rings (meters/kilometers), spatial intersection with defence parcels, results downloadable as Excel and PDF
- Topology checker: detects invalid geometries and overlapping parcels via PostGIS
- Measure tool with real-time length/area display
- Cloud-Optimized GeoTIFF (COG) layer overlay with per-layer opacity and visibility controls
- Shapefile (.zip) bulk import with background processing status
- Attribute table panel with inline editing, field calculator, find & replace, CSV export
- Print-to-PDF with north arrow, scale bar, legend, and coordinate grid
- Map bookmarks (saved extents) and Go-to coordinate
- Per-layer colour picker and label toggle (feature_id rendered as text)
- Admin boundary tile overlay via pg_tileserv (MVT)
- **Auto-load**: map remembers the last active project across sessions — layers are visible immediately on open without manual project selection

### Survey Workflow (Survey-Area-Wise)
- A single project can contain multiple **Survey Areas** (pockets), each with its own independent workflow
- Each survey area is linked to a project folder; the workflow tracks that pocket individually
- Status machine per area: `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PUBLISHED` with `RETURNED` paths at each stage
- Role-based transitions:
  - **SDO / Surveyor** — Submit area to Checker; re-submit after Checker returns it
  - **Checker** — Send area to Approver or return to SDO with mandatory remarks
  - **Approver** — Approve area or return from review with mandatory remarks
  - **DEO Admin** — Publish approved areas
- **Folder lock on submission**: when a survey area is submitted, its linked folder and all sub-folders (Doc, Shapefile, Raster) are immediately read-only — no draw, edit, delete, upload, or import operations are allowed until the area is returned for revision
- Lock indicator: locked folders display a gold lock icon in the folder tree; the map toolbar hides all write tools and shows a banner
- Versioned layer folders: Phase → Zone → Year → Ver-I / Ver-II / … / Final, auto-created on first use
- Auto-versioning: active version detected or created automatically when an SDO opens a project
- Final folder auto-created and features copied on approval
- Project sharing: grant read access to specific users
- Full per-area audit log (actor, remarks, timestamp) visible inline on each survey area card
- In-app notifications for every state transition

### Version Comparison
- Split-screen map view comparing any two VERSION folders side-by-side
- Shared OL `View` instance — pan/zoom syncs both panels simultaneously

### User & Organisation Management
- Hierarchical organisations: DGDE → PDDE → DEO → CEO → ADEO
- Roles: SUPERADMIN, DEO/CEO/ADEO_ADMIN, SDO, SURVEYOR, CHECKER, APPROVER, VIEWER, PDDE_VIEWER
- Admin-role protection: cannot delete or deactivate admin users
- Force-logout (deactivate) — effective immediately via SimpleJWT `is_active` check
- Per-user password change; admin-initiated password reset

### Master Data (SuperAdmin)
- CRUD management for State, District, Taluk, Village with cascading dropdowns
- Organisation records extended with Office ID, officer name, contact details, state/district linkage

### Documents & AI Assistant
- Per-project document upload (PDF, images) with MIME-type validation
- Background AI processing via Ollama (local LLM — no external API calls)
- Auto-generated survey report from project features and documents
- Interactive chat interface for project-specific Q&A against document context

### UI Themes
- Six built-in themes: Dark, Light, Navy, Forest, Midnight, Saffron
- All UI surfaces use CSS custom properties (`--bg-base`, `--bg-card`, `--accent`, etc.) ensuring full theme coverage across the header, sidebar, drawers, and map panels

### Exports
- GeoJSON, Shapefile, CSV, KML, GeoPackage export per layer
- Attribute table CSV export
- Buffer analysis Excel (one sheet per ring) and PDF
- AI-generated PDF survey report

---

## Technology Stack

| Layer | Technology |
|---|---|
| **Backend** | Python 3.11, Django 4.2, Django REST Framework 3.15 |
| **Spatial** | GeoDjango, PostGIS 16-3.4 (SRID 4326) |
| **Database** | PostgreSQL 16 |
| **Cache / Queue** | Redis 7, Celery 5.3 |
| **Map Tiles** | pg_tileserv (MapLibre Vector Tile server) |
| **AI / LLM** | Ollama (local inference), pdfplumber |
| **Frontend** | React 18, TypeScript, Vite |
| **Map Library** | OpenLayers 10.2 |
| **UI Components** | Ant Design 5.20 |
| **State Management** | Zustand 4.5, TanStack Query 5 |
| **PDF / Excel** | jsPDF 4.2, jspdf-autotable, SheetJS (xlsx) |
| **GeoTIFF** | geotiff.js 3.0.5 (COG display via OL WebGLTileLayer) |
| **Auth** | SimpleJWT 5.3 (short-lived access + refresh tokens) |
| **GIS Import/Export** | Fiona 1.9, Shapely 2.0 |
| **Monitoring** | Prometheus + Grafana |
| **Web Server** | Nginx (reverse proxy + static files), Gunicorn |
| **Containerisation** | Docker Compose |

---

## Architecture

```
Browser
  └── Nginx (:80/:443)
        ├── /api/          → Gunicorn → Django (4 workers)
        ├── /tiles/        → pg_tileserv
        └── /              → React SPA (static files)

Django
  ├── apps/accounts          — Users, Organisations
  ├── apps/survey_projects   — Projects, Survey Areas, Features, Folders, Parcels
  ├── apps/gis_layers        — State/District/Taluk/Village master data
  ├── apps/workflow          — Survey-area state machine, audit log, notifications
  ├── apps/documents         — File upload + AI processing
  ├── apps/ai_assistant      — Ollama chat + report generation
  └── apps/core              — Basemap configuration

Background Workers (Celery + Redis)
  ├── COG conversion task (GeoTIFF → Cloud-Optimized)
  ├── Shapefile import task
  └── AI document processing task

Data stores
  ├── PostgreSQL/PostGIS  — all relational + spatial data
  ├── Redis               — Celery broker + result backend
  └── /data/media/        — uploaded files, COG tiles
```

---

## Quick Start

### Prerequisites
- Docker Engine 24+
- Docker Compose v2
- 8 GB RAM minimum (16 GB recommended for Ollama)

### 1. Clone and configure
```bash
git clone <repo-url> RakshaGIS
cd RakshaGIS
cp .env.example .env
# Edit .env — set SECRET_KEY, DB passwords, OLLAMA_MODEL
```

### 2. Build and start
```bash
chmod +x build.sh RakshaGIS.sh
./build.sh          # builds Docker image (skips rebuild if unchanged)
./RakshaGIS.sh start
```

### 3. First-time setup
```bash
./RakshaGIS.sh manage migrate
./RakshaGIS.sh manage createsuperuser
```

### 4. Access
| Service | URL |
|---|---|
| Web application | http://localhost |
| API (browsable) | http://localhost/api/ |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3000 |

### Service management
```bash
./RakshaGIS.sh start       # start all services
./RakshaGIS.sh stop        # stop all services
./RakshaGIS.sh status      # check service health
./RakshaGIS.sh logs        # tail application logs
./RakshaGIS.sh backup      # dump PostgreSQL to /data/backups/
./RakshaGIS.sh restore <file>
```

---

## Project Structure

```
RakshaGIS/
├── apps/                  # Django applications
│   ├── accounts/          # Users, Organisations, authentication
│   ├── ai_assistant/      # Ollama chat + report generation
│   ├── core/              # Basemap configs
│   ├── documents/         # File management + AI processing
│   ├── gis_layers/        # Master GIS data (State/District/Taluk/Village)
│   ├── survey_projects/   # Projects, Survey Areas, Features, Folders, Parcels, GeoTiff
│   └── workflow/          # Survey-area approvals, audit log, notifications
├── config/                # Django settings, URLs, WSGI
├── frontend/              # React + TypeScript SPA
│   └── src/
│       ├── features/      # Page components by domain
│       │   ├── map/       # MapPage, AttributeTable, Buffer, Print
│       │   ├── projects/  # ProjectDetail, SurveyAreas, VersionCompare
│       │   ├── master/    # State/District/Taluk/Village CRUD
│       │   ├── users/     # User management
│       │   └── …
│       ├── app/           # Routes, Zustand store
│       ├── services/      # Axios instance, query keys
│       └── types/         # Shared TypeScript interfaces
├── nginx/                 # Nginx config
├── docker-compose.yml
├── Dockerfile
├── build.sh               # Smart build (hash-based skip)
└── RakshaGIS.sh           # Service manager
```

---

## API Reference

Interactive API documentation is available at `/api/schema/swagger-ui/` (drf-spectacular).

Key endpoint groups:

| Prefix | Description |
|---|---|
| `/api/accounts/` | Users, Organisations |
| `/api/projects/` | Survey projects, Features, Folders, Parcels |
| `/api/projects/survey-areas/` | Survey areas + per-area workflow |
| `/api/projects/buffer/` | Buffer analysis |
| `/api/projects/topology/` | Topology check |
| `/api/projects/{id}/active-version/` | Auto-version management |
| `/api/gis/` | Master GIS layers (State/District/Taluk/Village) |
| `/api/workflow/steps/` | Audit log |
| `/api/workflow/steps/area-transition/{area_pk}/{transition}/` | Survey-area workflow transitions |
| `/api/documents/` | File upload + AI processing |
| `/api/ai/` | Chat sessions, report generation |
| `/api/core/basemaps/` | Basemap configurations |
| `/tiles/` | MVT tiles via pg_tileserv |

---

## Roles & Permissions

| Role | Capabilities |
|---|---|
| SUPERADMIN | Full system access, master data management |
| DEO_ADMIN / CEO_ADMIN / ADEO_ADMIN | Manage users and orgs within own hierarchy; publish approved survey areas |
| SDO | Create/submit survey areas, draw/edit features in DRAFT/RETURNED areas |
| SURVEYOR | Draw and edit features in DRAFT/RETURNED survey areas |
| CHECKER | Review submitted areas, return or forward to approver |
| APPROVER | Approve or return areas from review |
| VIEWER / PDDE_VIEWER | Read-only map and report access |

---

## Environment Variables

| Variable | Description |
|---|---|
| `SECRET_KEY` | Django secret key |
| `DEBUG` | Set `False` in production |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `OLLAMA_BASE_URL` | Ollama service URL |
| `OLLAMA_MODEL` | Model name (e.g., `llama3.2`, `gemma3`) |
| `ALLOWED_HOSTS` | Comma-separated hostnames |
| `CORS_ALLOWED_ORIGINS` | Allowed frontend origins |
| `MEDIA_ROOT` | File upload directory |

---

## Licence

Developed for DGDE — Government of India. All rights reserved.
