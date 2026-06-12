# RakshaGIS — Defence Estate GIS Survey Platform

**A full-stack, self-hosted Geographic Information System for the Directorate General of Defence Estates (DGDE), Government of India.**

Everything runs on-premise. No commercial cloud services, no internet dependency after first installation.

---

## Table of Contents

1. [Overview](#overview)
2. [Key Features](#key-features)
3. [Technology Stack](#technology-stack)
4. [System Requirements](#system-requirements)
5. [Prerequisites](#prerequisites)
6. [Installation](#installation)
   - [Quick Start (Production)](#quick-start-production)
   - [Development Setup](#development-setup)
   - [Air-Gapped / Offline Installation](#air-gapped--offline-installation)
7. [Environment Variables](#environment-variables)
8. [Service Management](#service-management)
9. [First-Time Setup After Install](#first-time-setup-after-install)
10. [Optional Add-Ons](#optional-add-ons)
    - [Offline OSM Tile Server](#offline-osm-tile-server)
    - [Local AI (Ollama / LocalAI / LlamaCpp / AnythingLLM)](#local-ai)
    - [3D Terrain Server (SRTM/Cartosat)](#3d-terrain-server)
    - [HTTPS / TLS](#https--tls)
    - [Monitoring (Prometheus + Grafana)](#monitoring-prometheus--grafana)
11. [Admin Boundary Data Load](#admin-boundary-data-load)
12. [Real-Time Collaboration](#real-time-collaboration)
13. [Backup & Recovery](#backup--recovery)
14. [Multi-Language UI](#multi-language-ui)
15. [AI Features](#ai-features)
16. [API Reference](#api-reference)
17. [Roles & Permissions](#roles--permissions)
18. [Data Access Rules](#data-access-rules)
19. [Project Structure](#project-structure)
20. [Architecture](#architecture)
21. [External Data Layers](#external-data-layers)
22. [Map Printing & High-Resolution Export](#map-printing--high-resolution-export)
23. [Boundary Extraction & Review](#boundary-extraction--review)
24. [Offline PWA Field Companion](#offline-pwa-field-companion)
25. [Contributing](#contributing)
26. [Production Deployment Checklist](#production-deployment-checklist)
27. [Troubleshooting](#troubleshooting)
28. [Maintenance Notes & Resolved Issues](#maintenance-notes--resolved-issues)
29. [Project Background (DGDE)](#project-background-dgde)
30. [Licence](#licence)

---

## Overview

RakshaGIS is an enterprise-grade web GIS platform purpose-built for DGDE to digitise, manage, and publish defence land surveys. It replaces paper-based and siloed workflows with a single, role-gated system covering:

- Field surveying and GIS feature editing
- Survey-area-wise internal review and approval routing
- AI-assisted document processing, boundary extraction, attribute validation, and report generation
- In-browser document editing (OnlyOffice)
- Real-time collaborative editing by multiple surveyors
- 3D terrain and elevation analysis (Cesium.js + SRTM/Cartosat DEM) with vector overlay and DEM analysis tools
- Offline-first Progressive Web App (PWA) field companion for GPS-guided feature collection
- Per-feature comment threads for collaborative annotation
- C2PA and Living Provenance DNA watermarking on all exports
- Strict org-level data isolation: DGDE/PDDE see only their own org's content; subordinate data visible only through the published Map Viewer
- Hierarchical Office Drilldown dashboard (DGDE → PDDE command → DEO)
- Mandatory TOTP two-factor authentication enforced at first login
- Automated encrypted backups with rotation
- Multi-language UI (English, Hindi, Tamil, Telugu, Bengali, Kannada, Marathi)
- Published-layer sharing — all hosted on-premise with **zero cloud dependency**

---

## Key Features

### Map & Spatial Analysis
- Interactive map (OpenLayers 10) with multi-basemap support (OSM, XYZ, WMS/WMTS, Bhuvan)
- **Local offline raster tile server** — India OSM tiles served by `overv/openstreetmap-tile-server` after one-time import; no internet required during operation
- Draw and edit Point, Line, and Polygon features with snapping and live area/perimeter feedback
- Edit existing features (move vertices) with automatic backend sync
- Box-select and identify tools
- Buffer analysis (N configurable rings in metres/kilometres), spatial intersection with defence parcels, results downloadable as Excel and PDF
- Topology checker: detects invalid geometries and overlapping parcels via PostGIS
- Measure tool with real-time length/area display
- Cloud-Optimized GeoTIFF (COG) layer overlay with per-layer opacity and visibility controls
- Shapefile (.zip) bulk import with background processing status
- Attribute table panel with inline editing, field calculator, find & replace, CSV export
- Print-to-PDF with north arrow, scale bar, legend, and coordinate grid
- Map bookmarks (saved extents) and Go-to coordinate
- Per-layer colour picker and label toggle
- Admin boundary tile overlay via pg_tileserv (MVT)
- **Auto-load**: map remembers the last active project across sessions

### Survey Workflow (Survey-Area-Wise)
- A single project can contain multiple **Survey Areas** (pockets), each with its own independent workflow
- Status machine per area: `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PUBLISHED` with `RETURNED` paths at each stage
- Role-based transitions: SDO/Surveyor → Checker → Approver → DEO Admin (publish)
- **Folder lock on submission**: when a survey area is submitted, its linked folder tree is immediately read-only
- Versioned layer folders: Phase → Zone → Year → Ver-I / Ver-II / … / Final, auto-created on first use
- Full per-area audit log visible inline on each survey area card
- In-app notifications for every state transition

### Automated Boundary Dispute Detection
- Cross-project PostGIS `ST_Overlaps` check: flags when newly submitted features overlap published features from other organisations
- Pre-submission check returns HTTP 409 with conflict details
- Surveyor can review the overlap report and acknowledge before force-submitting
- Standalone "Check Disputes" button on each DRAFT/RETURNED survey area card
- All dispute checks stored as `DisputeReport` records for audit

### Real-Time Collaborative Editing
- WebSocket-based (Django Channels + Redis) — multiple surveyors work on the same project simultaneously
- Feature-level locking: when one surveyor starts editing a feature, others see it highlighted as locked
- Live presence indicator in the map toolbar (coloured avatars)
- Broadcasts: `feature_created`, `feature_updated`, `feature_deleted`, `feature_locked`, `feature_unlocked`
- Auto-reconnect with exponential backoff; locks auto-released on disconnect

### 3D Terrain & Elevation Analysis
- Full Cesium.js 3D globe at `/terrain`
- Load project GIS features as 3D extruded polygons/lines/points
- **Elevation query**: click any point to see lat/lon/elevation
- **Elevation profile**: draw a multi-segment line, see SVG elevation chart with min/max/length
- **DEM (Digital Elevation Model) analysis**: 16 analysis tools including slope, aspect, hillshade, curvature, TPI, TRI, roughness, flow direction, viewshed, and more — each produces a colour-rendered scene PNG with legend and statistics panel
- **Slope analysis**: sample a configurable grid (up to 50×50 = 2,500 points) over any drawn area, see min/avg/max slope in degrees with colour-coded overlay
- **Vector file upload**: import Shapefile (.zip), GeoJSON, KML/KMZ, or GeoPackage directly into the 3D viewer; Cesium renders the features as a 3D overlay for analysis
- **Terrain-area slope analysis from vector**: after loading a vector layer, trigger slope analysis over the bounding box in one click
- **PNG export with watermarking**: all scene captures (DEM analysis, slope, elevation) include C2PA + LP-DNA watermarks via the `/core/watermark-file/` pipeline
- Terrain sources: Ellipsoid (flat, default) · Local SRTM/Cartosat server (profile `terrain`) · Cesium ION (set token)
- Offline SRTM DEM setup via `./setup_terrain.sh`; `scripts/generate_terrain_layer.py` generates the correct `layer.json` availability index
- PWA and Coordinate Tool panels are collapsed to icon-only by default; click to expand

### Version Comparison
- Split-screen map view comparing any two VERSION folders side-by-side
- Shared OL `View` instance — pan/zoom syncs both panels simultaneously

### Strict Org-Level Data Isolation
- **Per-office isolation**: every project, survey area, GIS feature, folder, document, GeoTiff, and shapefile import is visible **only** to the office that created it
- **DGDE** — creates and manages its own org's content; reaches subordinate offices **only** through the published Map Viewer (read-only, published areas only); has no add/edit/delete rights over sub-office content
- **PDDE** — same as DGDE but scoped to its command subtree
- **SUPERADMIN accounts** attached to a DGDE/PDDE org are treated identically to DGDE/PDDE users (no bypass); only a superadmin with **no organisation** retains global system access
- Cross-org access request workflow: DEO can request read access to another org's survey area
- Explicit project sharing via `ProjectShare` grants; DEO-visible opt-in for CEO/ADEO sub-office layers
- All isolation enforced centrally via `hq_level()` + `org_queryset_filter()` — applies to viewsets, actions, dashboard, search, AI assistant, reports, and workflow

### Office Drilldown Dashboard
- Hierarchical stats dashboard: DGDE sees national → command level; click a command to see its DEO offices
- PDDE sees its own command → its DEO offices
- Each level shows: project counts by status, survey area counts, feature counts, document counts, active user counts
- Breadcrumb navigation; DEO is the terminal level (no sub-office breakdown)
- All aggregates are scoped to the visible subtree — HQ cannot see per-content details, only aggregate numbers

### Online Document Editing (OnlyOffice)
- OnlyOffice Community Document Server integrated as a Docker service — no licence required, fully offline
- View and edit `.docx`, `.odt`, `.xls`, `.xlsx`, `.pptx`, `.pdf` in the browser
- JWT-signed configuration; edit callback saves changes back to Django
- **Create blank report online**: generates a structured `.docx` in the project Doc folder and opens it immediately in OnlyOffice
- **Open any document**: click the OnlyOffice icon next to any document in the folder tree or Documents page

### AI Features (All Local — No Data Leaves the Server)
- **RAG (Retrieval-Augmented Generation)**: chunk project documents → embed via `nomic-embed-text` → cosine similarity retrieval → context-injected answers in AI Chat
- **AI Chat with project context**: select a project in the chat UI to enable RAG-powered Q&A
- **Vision boundary extraction**: upload a scanned paper map → LLaVA/Ollama vision model → extracted parcel JSON (survey numbers, areas, shapes, adjacent parcels, map metadata)
- **DGDE domain model**: `POST /api/ai/rag/create-dgde-model/` creates an Ollama model with a comprehensive DGDE system prompt baked in
- **Training dataset export**: exports project documents as JSONL instruction/response pairs for local LoRA fine-tuning
- AI-generated survey reports (`.docx` + PDF) from project features and documents
- Background AI document processing: pdfplumber extraction + Ollama summarisation

### Automated Backup & Recovery
- **Full DB backup**: Django `dumpdata` → gzip → optional AES-128 Fernet encryption
- **Command-level backup (PDDE subtree)**: exports all orgs/users/projects/features/documents/workflow under a PDDE command as a structured ZIP
- **Office-level backup (DEO/CEO/ADEO)**: same but scoped to a single office
- PDDE/DEO/CEO/ADEO admins can **download their own org's backups**; SuperAdmin manages all
- Celery Beat automated schedules: daily/weekly/monthly with configurable retention
- Automatic rotation of expired backup files
- Encryption key auto-generated and stored in `BACKUP_DIR/.backup_key` if `BACKUP_ENCRYPTION_KEY` not set

### Admin Boundary Data Load
- Management command: `manage.py load_admin_boundaries` — import state/district/taluk/village shapefiles into PostGIS
- Supports GADM, Census of India, Survey of India, and Bhuvan shapefile conventions
- Web-based upload via SuperAdmin → Master Data → Boundary Import (background Celery task)
- Auto-reprojects to EPSG:4326, forces MultiPolygon, supports `--clear`, `--dry-run`, `--spatial-parent`

### Multi-Language UI
- Fully localised into 7 Indian languages: **English, Hindi, Tamil, Telugu, Bengali, Kannada, Marathi**
- Language switcher in header and login page — persists to `localStorage`
- Ant Design component strings translated for Hindi (`antd/locale/hi_IN`)
- All untranslated keys fall back to English — no broken UI

### Mandatory Two-Factor Authentication (2FA)
- **Enforced TOTP** (Time-based One-Time Password) for all users
- First login: user must scan QR code with any TOTP app (Google Authenticator, Authy, etc.) and confirm a valid code before the session token is issued — no bypass
- Subsequent logins: OTP entry required; `±60 s` clock tolerance (`valid_window=2`)
- Backend: `pyotp` + `TOTPDevice` model; setup flow via `/api/accounts/auth/2fa/setup-begin/` → `/api/accounts/auth/2fa/setup-complete/`
- Login never issues tokens directly — always returns `requires_2fa_setup` or `requires_2fa` status

### C2PA & Living Provenance DNA Watermarking
- All terrain analysis exports (DEM PNG, slope PNG, GeoJSON, CSV), uploaded documents, and report PDFs are watermarked before download
- **C2PA** (Content Authenticity Initiative): embeds cryptographic provenance assertions readable by Adobe and other C2PA-aware tools
- **LP-DNA** (Living Provenance DNA): invisible steganographic metadata binding the export to the project, uploader, and timestamp
- Central watermark pipeline at `/api/core/watermark-file/` — used by all export paths
- PDF reports use LP-DNA only (C2PA is limited to image/office formats)

### Per-Feature Comment Threads
- Any GIS feature can carry a threaded discussion visible to all users with project access
- Comments stored in `FeatureComment` (feature FK, user, text, timestamp)
- Shown in the **Feature Info drawer** on the Map page with role-coloured user tags and an inline reply box
- REST API: `/api/projects/feature-comments/?feature=<id>`

### Attribute Auto-Validator
- Runs automatically after every shapefile import completes
- Checks for: duplicate feature IDs, missing required attributes, zero-area polygons, features outside the India bounding box
- Results stored in `ShapefileImport.validation_warnings` (JSON list)
- Summary emailed to the uploader; shown in the Import Status UI
- An AI review task is also queued to check attribute completeness against the project's `AttributeTemplate`

### AI Survey Report Generator
- Generate a structured AI-authored survey report from any project in one click
- Backend gathers project stats (area counts by status, feature counts, document inventory) and asks the local LLM to write a narrative summary with findings and recommendations
- Output: formatted PDF (LP-DNA watermarked) + `.docx` stored as a project document
- Accessible from the Reports page (`AI_SUMMARY` report type) or the AI Assistant panel
- Fully local — LLM runs on-premise via Ollama

### User & Organisation Management
- Hierarchical organisations: DGDE → PDDE → DEO → CEO → ADEO
- 10 roles: SUPERADMIN, PDDE_VIEWER, VIEWER, DEO_ADMIN, CEO_ADMIN, ADEO_ADMIN, SDO, SURVEYOR, CHECKER, APPROVER
- Force-logout, per-user password change, admin-initiated password reset
- Mandatory TOTP two-factor authentication enforced at first login for all users

### Master Data (SuperAdmin)
- CRUD for State, District, Taluk, Village with cascading dropdowns
- PostGIS geometry fields on each level — boundaries visualised on the map and served as MVT tiles

---

## Technology Stack

| Layer | Technology | Version |
|---|---|---|
| **Backend** | Python / Django | 3.11 / 4.2 |
| **REST API** | Django REST Framework | 3.15 |
| **Spatial** | GeoDjango, PostGIS | — / 16-3.4 |
| **Database** | PostgreSQL | 16 |
| **Cache / Queue** | Redis, Celery | 7 / 5.3 |
| **WebSocket** | Django Channels, Daphne | 4.1 / 4.1 |
| **Map Tiles (vector)** | pg_tileserv | latest |
| **Map Tiles (raster)** | openstreetmap-tile-server | 2.3.0 |
| **Document Editing** | OnlyOffice Community | 8.2.2 |
| **AI / LLM** | Ollama, LocalAI, llama.cpp, AnythingLLM | — |
| **PDF Extraction** | pdfplumber | 0.11 |
| **Backup Encryption** | cryptography (Fernet) | 43.0 |
| **Frontend** | React 18, TypeScript, Vite | 18 / 5 / 5.4 |
| **Map Library** | OpenLayers | 10.2 |
| **3D Globe** | Cesium.js | 1.141 |
| **UI Components** | Ant Design | 5.20 |
| **State Management** | Zustand, TanStack Query | 4.5 / 5 |
| **i18n** | i18next, react-i18next | — |
| **PDF / Excel** | jsPDF, SheetJS | — |
| **GeoTIFF** | geotiff.js (COG via OL WebGLTileLayer) | 3.0 |
| **Auth** | SimpleJWT | 5.3 |
| **GIS Import/Export** | Fiona, Shapely | 1.9 / 2.0 |
| **Monitoring** | Prometheus + Grafana | — |
| **Web Server** | nginx, Daphne (ASGI) | 1.27 / 4.1 |
| **Containerisation** | Docker Compose | v2 |

---

## System Requirements

### Minimum (Functional — No AI)
| Component | Minimum |
|---|---|
| CPU | 4 cores (x86-64) |
| RAM | 8 GB |
| Disk | 40 GB (SSD preferred) |
| OS | Ubuntu 22.04 LTS / Debian 12 / RHEL 9 |
| Docker Engine | 24.0+ |
| Docker Compose | v2.20+ |

### Recommended (With Local AI)
| Component | Recommended |
|---|---|
| CPU | 8+ cores |
| RAM | 32 GB (16 GB minimum with small models) |
| Disk | 200 GB SSD |
| GPU | NVIDIA with 8+ GB VRAM (optional — CPU inference works, slower) |

### For OSM Tile Server (Offline Map)
- Additional 20 GB disk for India OSM data + tile cache
- 2–4 hours import time on first run

### For 3D Terrain (SRTM/Cartosat)
- Additional 15 GB disk for India DEM tiles
- 3–5 hours conversion time on first run

---

## Prerequisites

Install these **on the host machine** before running RakshaGIS.

### 1. Docker Engine

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version        # should be 24.0+
docker compose version  # should be v2.20+
```

### 2. Git

```bash
sudo apt-get install -y git
```

### 3. Required Ports (must be free on the host)
| Port | Service |
|---|---|
| 80 | nginx (HTTP) |
| 443 | nginx (HTTPS — optional) |
| 5432 | PostgreSQL (internal) |
| 6379 | Redis (internal) |
| 8000 | Daphne/Django (internal, proxied by nginx) |
| 9090 | Prometheus (optional monitoring) |
| 3000 | Grafana (optional monitoring) |
| 3001 | AnythingLLM (optional AI) |
| 11434 | Ollama (optional AI — if running on host) |

> **Tip:** Only port 80 (and 443 for HTTPS) need to be open externally. All others are internal Docker network ports.

---

## Installation

### Quick Start (Production)

```bash
# 1. Clone the repository
git clone <repo-url> RakshaGIS
cd RakshaGIS

# 2. Copy and edit the environment file
cp .env.example .env
nano .env          # At minimum set: SECRET_KEY, DB_PASSWORD, ONLYOFFICE_JWT_SECRET

# 3. Build the Docker image
chmod +x build.sh RakshaGIS.sh setup_terrain.sh
./build.sh

# 4. Start all core services
./RakshaGIS.sh start

# 5. Run first-time setup (migrations + seed data + superuser)
./RakshaGIS.sh manage migrate
./RakshaGIS.sh manage createsuperuser
./RakshaGIS.sh manage seed_basemaps

# 6. Open the application
# Web:       http://localhost  (or your server IP)
# API docs:  http://localhost/api/schema/swagger-ui/
```

> The application is now running. Log in with the superuser credentials you created in step 5.

**Note on image naming**: Images should be tagged as `rakshagis:web` (not `<none>`). Verify:
```bash
docker image ls | grep rakshagis:web
```

---

### Development Setup

For local development with hot-reload:

```bash
# 1. Start only backend services
docker compose up db redis pg_tileserv -d

# 2. Install Python dependencies (use a virtualenv)
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 3. Set up environment
cp .env.example .env
export DJANGO_SETTINGS_MODULE=config.settings.development
export DATABASE_URL=postgres://raksha:yourpassword@localhost:5432/rakshagis

# 4. Create migrations (if you modified Django models)
python manage.py makemigrations

# 5. Run migrations
python manage.py migrate
python manage.py createsuperuser
python manage.py seed_basemaps

# 6. Start Django dev server
python manage.py runserver 0.0.0.0:8000

# 7. In another terminal: start Celery worker
celery -A config worker --loglevel=info

# 8. In another terminal: start frontend dev server
cd frontend
npm install
npm run dev
# Frontend available at http://localhost:5173
# API proxied to http://localhost:8000
```

#### Build frontend for production

```bash
cd frontend
npm run build
# Copies index.html to templates/ automatically
# Static assets output to ../static/frontend/
```

---

### Air-Gapped / Offline Installation

For deployment on networks **without internet access**:

```bash
# ── On a machine WITH internet ──────────────────────────────────────

# 1. Clone the repo and configure .env
git clone <repo-url> RakshaGIS && cd RakshaGIS
cp .env.example .env

# 2. Pull all Docker images and save them as a single archive
./build.sh --save-images
# Creates: RakshaGIS_images.tar.gz in the data directory

# ── Transfer files to the air-gapped machine ───────────────────────
# Transfer: the entire RakshaGIS/ directory + RakshaGIS_images.tar.gz

# ── On the air-gapped machine ──────────────────────────────────────

# 3. Load all images from the archive (no internet pull)
./build.sh --load-images /path/to/RakshaGIS_images.tar.gz

# 4. Build the app image from local source
./build.sh --no-build     # skip pull, just build the web image

# 5. Start
./RakshaGIS.sh start
./RakshaGIS.sh manage migrate
./RakshaGIS.sh manage createsuperuser
./RakshaGIS.sh manage seed_basemaps
```

---

## Environment Variables

Copy `.env.example` to `.env` and set these values. Required fields are marked **\***.

### Django Core

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | — | **\* Required.** Long random string. Generate: `python -c "import secrets; print(secrets.token_hex(50))"` |
| `DEBUG` | `False` | Set `True` only in development |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames / IPs |
| `CORS_ALLOWED_ORIGINS` | — | Allowed frontend origins (production with separate frontend domain) |
| `DJANGO_SETTINGS_MODULE` | `config.settings.production` | Use `config.settings.development` for dev |

### Database

| Variable | Default | Description |
|---|---|---|
| `DB_NAME` | `rakshagis` | PostgreSQL database name |
| `DB_USER` | `raksha` | **\* Required.** PostgreSQL user |
| `DB_PASSWORD` | — | **\* Required.** PostgreSQL password |
| `DB_HOST` | `db` (Docker) / `localhost` (dev) | Database host |
| `DB_PORT` | `5432` | Database port |
| `DATA_DIR` | `/data/rakshagis` | Host path for all persistent data (PostgreSQL, media, backups) |

### Redis / Celery

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection URL |
| `CELERY_BROKER_URL` | `redis://redis:6379/1` | Celery broker URL |

### OnlyOffice

| Variable | Default | Description |
|---|---|---|
| `ONLYOFFICE_JWT_SECRET` | — | **\* Required.** Shared secret for OnlyOffice JWT signing. Generate: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `ONLYOFFICE_INTERNAL_BASE_URL` | `http://nginx` | Internal URL OnlyOffice uses to reach Django (keep as `http://nginx` in Docker) |

### Local AI

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `llama3.2` | Default LLM model name |
| `OLLAMA_HOST_URL` | `http://host.docker.internal:11434` | Ollama on Docker Desktop host |
| `OLLAMA_LOCAL_URL` | `http://localhost:11434` | Ollama running directly on host |

### 3D Terrain

| Variable | Default | Description |
|---|---|---|
| `CESIUM_ION_TOKEN` | *(empty)* | Cesium ION access token for Cesium World Terrain. Free at [ion.cesium.com](https://ion.cesium.com). Leave empty to use local terrain server or flat terrain. |
| `TERRAIN_TILE_URL` | *(empty)* | URL of local quantized-mesh terrain tile server. Set to `/terrain-tiles` when using the `terrain` Docker profile. |

### Backup & Recovery

| Variable | Default | Description |
|---|---|---|
| `BACKUP_ENCRYPTION_KEY` | *(auto-generated)* | Fernet encryption key for backup files. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. If not set, a key is auto-generated and stored in `BACKUP_DIR/.backup_key`. |
| `BACKUP_DIR` | `<project>/data/backups` | Directory where backup files are stored |
| `BACKUP_RETENTION_DAYS` | `30` | Default retention period for manual backups (days) |

### Media & Static

| Variable | Default | Description |
|---|---|---|
| `MEDIA_ROOT` | `/data/media` | User upload directory |

---

## Service Management

All service management is done via `./RakshaGIS.sh`:

```bash
./RakshaGIS.sh start       # Start all core services (nginx, web, celery, db, redis, pg_tileserv)
./RakshaGIS.sh stop        # Stop all services
./RakshaGIS.sh restart     # Restart all services
./RakshaGIS.sh status      # Show service health and resource usage
./RakshaGIS.sh logs        # Tail application logs
./RakshaGIS.sh logs web    # Tail logs for a specific service
./RakshaGIS.sh backup      # Create a raw PostgreSQL dump (pg_dump from db container)
./RakshaGIS.sh restore <file>  # Restore from a .sql.gz backup file
./RakshaGIS.sh update      # Pull latest images, rebuild, restart
./RakshaGIS.sh info        # Show version and configuration summary
```

### Running Django Management Commands

```bash
./RakshaGIS.sh manage <command>

# Examples:
./RakshaGIS.sh manage migrate
./RakshaGIS.sh manage createsuperuser
./RakshaGIS.sh manage seed_basemaps
./RakshaGIS.sh manage shell
./RakshaGIS.sh manage dumpdata > backup.json
```

Or directly via Docker Compose:

```bash
docker compose run --rm web python manage.py <command>
```

---

## First-Time Setup After Install

After starting the services for the first time:

### 1. Run Database Migrations

```bash
./RakshaGIS.sh manage migrate
```

### 2. Create a SuperAdmin Account

```bash
./RakshaGIS.sh manage createsuperuser
# Enter: username, email, password
```

### 3. Seed Default Basemaps

```bash
./RakshaGIS.sh manage seed_basemaps
# Creates: OpenStreetMap, CartoDB Dark, Esri Satellite basemaps
```

### 4. Access the Application

| URL | Description |
|---|---|
| `http://localhost` | Main web application |
| `http://localhost/api/` | REST API (browsable) |
| `http://localhost/api/schema/swagger-ui/` | API documentation (Swagger UI) |
| `http://localhost/onlyoffice/` | OnlyOffice server (internal) |

### 5. Create Organisations and Users

1. Log in as SuperAdmin
2. Go to **Organisations** → create the PDDE, DEO/CEO hierarchy
3. Go to **Users** → create users and assign them to organisations with appropriate roles

---

## Optional Add-Ons

### Offline OSM Tile Server

Serves India OpenStreetMap raster tiles entirely offline. **One-time internet download (~800 MB), then fully offline.**

```bash
# Step 1: Import India OSM data (requires internet once; takes 2–4 hours)
./build.sh --import-osm

# Step 2: Activate in the app
# Settings → Basemaps → Enable "Local OSM (Offline)"
```

- Disk requirement: ~20 GB for PostGIS data + tile cache
- After import, the service starts automatically with `./RakshaGIS.sh start`

---

### Local AI

RakshaGIS supports multiple local LLM backends. All are optional and run fully on-premise.

#### Option A: Ollama (Recommended)

Best for most deployments. Supports Llama 3, Mistral, Gemma, DeepSeek, and many more.

**Running Ollama on the host (recommended for GPU setups):**

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull models
ollama pull llama3.2          # 2.0 GB — general chat
ollama pull nomic-embed-text  # 274 MB — RAG embeddings (REQUIRED for RAG)
ollama pull llava:7b          # 4.7 GB — vision model for map boundary extraction
ollama pull moondream         # 850 MB — lightweight vision model

# Set in .env:
# OLLAMA_LOCAL_URL=http://localhost:11434
# OLLAMA_MODEL=llama3.2
```

**Running Ollama in Docker (CPU):**

```bash
docker compose --profile docker-ollama up -d ollama
docker compose exec ollama ollama pull llama3.2
```

**Running Ollama in Docker (NVIDIA GPU):**

```bash
docker compose --profile docker-ollama-gpu up -d ollama
docker compose exec ollama ollama pull llama3.2
```

#### Option B: LocalAI

OpenAI-compatible API for GGUF/GGML models.

```bash
# CPU
docker compose --profile localai up -d localai

# NVIDIA GPU
docker compose --profile localai-gpu up -d localai

# Set in .env:
# OLLAMA_BASE_URL=http://localai:8080
```

#### Option C: llama.cpp Server

Lightweight, fast inference from GGUF files.

```bash
# CPU
docker compose --profile llamacpp up -d llamacpp

# NVIDIA GPU
docker compose --profile llamacpp-gpu up -d llamacpp
```

#### Option D: AnythingLLM

Full RAG workspace with document management.

```bash
# CPU
docker compose --profile anythingllm up -d anythingllm

# NVIDIA GPU
docker compose --profile anythingllm-gpu up -d anythingllm

# AnythingLLM UI: http://localhost:3001
```

#### Configuring the Active LLM

After starting an AI backend:

1. Log in as SuperAdmin
2. Go to **AI Config** → **Add LLM Configuration**
3. Set the provider URL and model name
4. Click **Activate** to make it the default

---

### 3D Terrain Server

Serves SRTM/Cartosat DEM tiles in Cesium's quantized-mesh format for the 3D Terrain viewer.

#### Step 1: Download India SRTM DEM tiles

```bash
# Downloads ~250 MB of SRTM 5×5° tiles covering India from CGIAR-CSI
./setup_terrain.sh --download
```

#### Step 2: Convert to quantized-mesh format

```bash
# Converts GeoTIFF DEM → Cesium quantized-mesh tiles using ctb-tile (Docker)
# Takes 1–3 hours for full India coverage at zoom levels 0–14
./setup_terrain.sh --convert

# Or do both steps at once:
./setup_terrain.sh --all
```

> **Requires Docker** for the `ctb-tile` and `osgeo/gdal` containers (pulled automatically).

#### Step 3: Start the terrain server

```bash
docker compose --profile terrain up -d terrain-server
```

#### Step 4: Activate in `.env`

```bash
TERRAIN_TILE_URL=/terrain-tiles
```

Then restart the web service:

```bash
./RakshaGIS.sh restart
```

> **Without SRTM data:** The 3D viewer still works with flat (ellipsoid) terrain — features load in 3D, slope analysis shows 0°. Real elevation requires the terrain server.

---

### HTTPS / TLS

For production deployments with a public domain name:

```bash
# Set your domain in .env:
# ALLOWED_HOSTS=your-domain.com
# CORS_ALLOWED_ORIGINS=https://your-domain.com

# Uncomment the HTTPS redirect in deploy/nginx-docker.conf

# Start Certbot for Let's Encrypt:
docker compose --profile https up -d certbot

# Renew certificates (run periodically via cron):
docker compose --profile https run --rm certbot renew
```

---

### Monitoring (Prometheus + Grafana)

```bash
docker compose --profile monitoring up -d prometheus grafana

# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3000  (default login: admin / admin)

# Django metrics endpoint: http://localhost/metrics/
```

---

## Admin Boundary Data Load

Load state, district, taluk, and village boundary shapefiles into the master data tables (required for the MVT boundary overlay on the map and for spatial filtering).

### Method 1: Management Command (recommended for bulk loads)

Uses GADM 4.1 India shapefiles by default. Download from [gadm.org](https://gadm.org/download_country.html):

```bash
# Load states (run first)
./RakshaGIS.sh manage load_admin_boundaries \
    --level state \
    --file /path/to/gadm41_IND_1.shp \
    --name-field NAME_1 \
    --code-field GID_1

# Load districts (requires states loaded first)
./RakshaGIS.sh manage load_admin_boundaries \
    --level district \
    --file /path/to/gadm41_IND_2.shp \
    --name-field NAME_2 \
    --code-field GID_2 \
    --parent-code-field GID_1

# Load taluks/sub-districts
./RakshaGIS.sh manage load_admin_boundaries \
    --level taluk \
    --file /path/to/gadm41_IND_3.shp \
    --name-field NAME_3 \
    --code-field GID_3 \
    --parent-code-field GID_2

# Load villages
./RakshaGIS.sh manage load_admin_boundaries \
    --level village \
    --file /path/to/gadm41_IND_4.shp \
    --name-field NAME_4 \
    --code-field GID_4 \
    --parent-code-field GID_3
```

#### All options:
```
--level           state | district | taluk | village
--file            Path to .shp or .zip shapefile
--name-field      Attribute column for record name (default: NAME)
--code-field      Attribute column for unique code (default: CODE)
--parent-code-field  Attribute whose value matches the parent's code
--spatial-parent  Resolve parent by centroid-in-polygon (no parent-code-field needed)
--clear           Delete all existing records for this level before importing
--dry-run         Parse and validate without writing to the database
--batch-size      Bulk-create batch size (default: 500)
```

### Method 2: Web UI (SuperAdmin)

1. Log in as SuperAdmin
2. Go to **Master Data → Boundary Import**
3. Select level, upload a `.shp` or `.zip` file, set field names (GADM defaults pre-filled)
4. Click **Start Import** — the task runs in the background via Celery
5. Monitor progress in the Import History table

---

## Real-Time Collaboration

Multiple surveyors can edit the same project simultaneously.

### How it works

- When you open a project on the Map page, a WebSocket connection is automatically established to `ws[s]://<host>/ws/project/<id>/`
- The **presence indicator** (top-right of the map) shows coloured avatars of all connected users
- When another user draws, edits, or deletes a feature, your map updates instantly
- **Feature locking**: if another user is editing a feature, it shows as locked on your map

### Prerequisites

The WebSocket requires:
- nginx with the `/ws/` proxy block (already configured in `deploy/nginx-docker.conf`)
- Redis running (used as the channel layer)
- Daphne ASGI server (default since v2.0 — replaces gunicorn)

### Troubleshooting collaboration

```bash
# Check channel layer is connected to Redis
docker compose exec web python manage.py shell -c "
from channels.layers import get_channel_layer
import asyncio
cl = get_channel_layer()
asyncio.run(cl.group_add('test', 'test'))
print('Channel layer OK:', cl.__class__.__name__)
"

# Check WebSocket URL is reachable
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
    http://localhost/ws/project/1/?token=<jwt_token>
```

---

## Backup & Recovery

### Creating a Manual Backup

1. Log in as **SuperAdmin**
2. Go to **Backups** → **Manual Backup** tab
3. Select backup type:
   - **Full Database**: entire Django database (all apps, all organisations)
   - **Command (PDDE)**: all data for a PDDE command and all subordinate orgs
   - **Office (DEO/CEO/ADEO)**: all data for a single office
4. Select the target organisation (for Command/Office types)
5. Toggle **Encrypt** (on by default — AES-128 Fernet)
6. Click **Start Backup** — runs in the background via Celery
7. When status shows **Done**, click **Download** to get the file (automatically decrypted on download)

### Downloading Backups (PDDE/DEO Admins)

PDDE, DEO, CEO, and ADEO admins can download backups that cover their organisation:

1. Log in with your admin account
2. Go to **Backups** — you will see only backups covering your org/command
3. Click **Download** on any **Done** backup

### Automated Backup Schedules

SuperAdmin can configure automated schedules:

1. Go to **Backups → Schedules** tab
2. Click **Add Schedule**, set:
   - Name, Type (Full/Command/Office), Target org
   - Frequency (Daily/Weekly/Monthly), UTC hour
   - Retention days (default 30)
   - Encrypt toggle
3. Click **Add** — Celery Beat will trigger this automatically

### Backup File Format

| Type | Format | Contents |
|---|---|---|
| Full DB | `full_YYYYMMDD_HHMMSS.json.gz[.enc]` | Django dumpdata — all tables as JSON |
| Command | `command_<CODE>_YYYYMMDD.zip[.enc]` | ZIP: organisations.json, users.json, projects.json, survey_areas.json, features.geojson, folders.json, workflow_steps.json, documents.json + document files |
| Office | `office_<CODE>_YYYYMMDD.zip[.enc]` | Same as Command, single-org scope |

### Restore a Full Backup

```bash
# Decrypt if encrypted (only needed if you want to inspect the file)
python -c "
from cryptography.fernet import Fernet
key = open('/data/backups/.backup_key','rb').read().strip()
f = Fernet(key)
data = f.decrypt(open('backup.json.gz.enc','rb').read())
open('backup.json.gz','wb').write(data)
"

# Decompress
gunzip backup.json.gz

# Restore (will overwrite existing data)
./RakshaGIS.sh manage loaddata backup.json
```

### Command-Line Backup (Raw pg_dump)

```bash
./RakshaGIS.sh backup
# Creates: /data/rakshagis/backups/rakshagis_backup_YYYYMMDD_HHMMSS.sql.gz
```

---

## Multi-Language UI

RakshaGIS supports 7 Indian languages out of the box.

### Switching Language

**In the app** (after login): Click the language button in the header toolbar (shows current language in native script).

**On the login page**: Use the language button at the bottom of the login card.

### Available Languages

| Code | Language | Script |
|---|---|---|
| `en` | English | Latin |
| `hi` | हिन्दी (Hindi) | Devanagari |
| `ta` | தமிழ் (Tamil) | Tamil |
| `te` | తెలుగు (Telugu) | Telugu |
| `bn` | বাংলা (Bengali) | Bengali |
| `kn` | ಕನ್ನಡ (Kannada) | Kannada |
| `mr` | मराठी (Marathi) | Devanagari |

Language selection is stored in the browser's `localStorage` key `raksha_language` and persists across sessions.

### Adding or Updating Translations

Edit the JSON files in `frontend/src/i18n/locales/`. Missing keys fall back to English automatically.

```bash
# After editing translation files, rebuild:
cd frontend && npm run build
./RakshaGIS.sh manage collectstatic --noinput
./RakshaGIS.sh restart
```

---

## AI Features

All AI inference is **100% local** — no data leaves the deployment host.

### RAG (Retrieval-Augmented Generation)

Provides context-aware answers using your actual project documents.

```
1. Upload documents to a project
2. Run AI processing: Documents page → "Process AI" button
3. Go to AI Vision page → click "Embed Docs for RAG" (select the project)
   - Ollama embeds each document chunk using nomic-embed-text
4. Open AI Chat → select the project from the "RAG Context" dropdown
5. Ask questions — the system retrieves relevant chunks and injects them as context
6. The response shows which document chunks were used as sources
```

**Required model:**
```bash
ollama pull nomic-embed-text   # 274 MB — embedding model for RAG
```

### Vision Boundary Extraction

Extracts parcel information from scanned paper survey maps.

```
1. Go to AI Vision page
2. Select a project
3. Upload a scanned map image (JPEG/PNG/TIFF)
4. Select vision model (llava:7b recommended)
5. Click "Extract Boundaries"
6. Review extracted results:
   - Map metadata (title, scale, district, village, date, surveyor)
   - Per-parcel: survey number, area, shape, adjacent parcels
7. Use the extracted data to manually draw features on the Map page
```

**Required model:**
```bash
ollama pull llava:7b        # 4.7 GB — best quality
# OR
ollama pull moondream       # 850 MB — faster, lower detail
```

### AI Survey Report Generator

Generate a full AI-authored survey report for any project:

```
1. Go to Reports → New Schedule
2. Set type = "AI Survey Summary"
3. Click "Send Now" (or schedule)
4. The task gathers project stats, feature counts, document inventory, and asks the
   local LLM to write a structured narrative
5. Output: PDF (LP-DNA watermarked) + .docx saved as a project document
```

### Attribute Auto-Validator

Runs automatically after every shapefile import:

```
1. Import a Shapefile (.zip) via Projects → Shapefile Import
2. The Celery task imports features then calls _validate_imported_features()
3. Checks: duplicate IDs, missing required attributes, zero-area polygons, out-of-India bbox
4. Results appear in the Import Status row (validation_warnings field)
5. AI review is also queued to check attribute completeness vs. the project AttributeTemplate
```

### DGDE Domain Model

Creates an Ollama model specialised in DGDE/survey domain knowledge:

```bash
# Via API (SuperAdmin only):
curl -X POST http://localhost/api/ai/rag/create-dgde-model/ \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"base_model": "llama3.2", "model_name": "dgde-expert"}'

# Then activate it in AI Config → set "dgde-expert" as the active model
```

### Training Dataset Export

Exports project documents as JSONL for local LoRA fine-tuning:

```
AI Vision page → "Export Training Data" button (per project)
Output: /data/media/training/<project_id>_training.jsonl
```

---

## API Reference (additions)

See also the [Offline PWA section](#offline-pwa-field-companion) and [Contributing](#contributing).

## API Reference

Interactive API documentation: `http://localhost/api/schema/swagger-ui/`

| Prefix | Description |
|---|---|
| `/api/accounts/users/` | User CRUD, force-logout, change-password |
| `/api/accounts/organisations/` | Organisation CRUD |
| `/api/projects/` | Survey projects |
| `/api/projects/survey-areas/` | Survey areas, workflow transitions, dispute check, reports |
| `/api/projects/features/` | GIS features |
| `/api/projects/folders/` | Project layer folders |
| `/api/projects/buffer/` | Buffer analysis |
| `/api/projects/topology/` | Topology check |
| `/api/gis/states/` | State master data |
| `/api/gis/districts/` | District master data |
| `/api/gis/taluks/` | Taluk master data |
| `/api/gis/villages/` | Village master data |
| `/api/gis/boundary-imports/` | Admin boundary import jobs |
| `/api/workflow/steps/` | Audit log |
| `/api/workflow/steps/area-transition/{area}/{transition}/` | Workflow transitions |
| `/api/workflow/steps/dispute-check/{area_pk}/` | Boundary dispute check |
| `/api/documents/` | File upload, OnlyOffice integration, AI processing |
| `/api/documents/create-blank/` | Create blank online document |
| `/api/ai/chat/` | AI chat sessions |
| `/api/ai/tasks/` | AI background tasks |
| `/api/ai/llm-configs/` | LLM configuration management |
| `/api/ai/rag/embed-project/{id}/` | Queue RAG document embedding |
| `/api/ai/rag/embed-status/{id}/` | RAG embedding status |
| `/api/ai/rag/create-dgde-model/` | Create DGDE domain model |
| `/api/ai/vision/submit/` | Vision boundary extraction job |
| `/api/ai/vision/status/{id}/` | Vision job status + results |
| `/api/backups/jobs/` | Backup job management |
| `/api/backups/jobs/{id}/download/` | Download (and decrypt) backup file |
| `/api/backups/schedules/` | Backup schedule management |
| `/api/external/databases/` | External DB connections (SUPERADMIN) |
| `/api/external/layers/` | External DB layers — list, geojson, search, distinct-values |
| `/api/external/gis-servers/` | GIS Server connections — CRUD, test, capabilities |
| `/api/external/gis-server-layers/` | GIS Server layers — CRUD, features, tile-config |
| `/api/core/basemaps/` | Basemap configurations |
| `/api/core/terrain-config/` | Terrain/Cesium configuration |
| `/api/core/terrain/vector-upload/` | Upload Shapefile/GeoJSON/KML/KMZ/GPKG for 3D terrain overlay |
| `/api/core/watermark-file/` | Embed C2PA + LP-DNA watermark in a file before download |
| `/api/core/elevation/` | Batch elevation lookup (up to 5,000 points) |
| `/api/accounts/auth/2fa/setup-begin/` | Start TOTP 2FA registration — returns QR URI |
| `/api/accounts/auth/2fa/setup-complete/` | Complete 2FA registration with first OTP |
| `/api/projects/feature-comments/` | Per-feature comment threads (CRUD) |
| `/api/dashboard/org-drilldown/` | Hierarchical org stats (DGDE→command→office) |
| `/tiles/` | MVT vector tiles via pg_tileserv |
| `/osm-tiles/{z}/{x}/{y}.png` | Offline India raster tiles |
| `/terrain-tiles/` | SRTM/Cartosat quantized-mesh terrain tiles |
| `/ws/project/{id}/` | WebSocket: real-time collaboration |

### Authentication

All API endpoints require a JWT Bearer token:

```bash
# Get token
curl -X POST http://localhost/api/accounts/token/ \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "yourpassword"}'

# Use token
curl http://localhost/api/projects/ \
  -H "Authorization: Bearer <access_token>"

# Refresh token
curl -X POST http://localhost/api/accounts/token/refresh/ \
  -d '{"refresh": "<refresh_token>"}'
```

---

## Roles & Permissions

| Role | Capabilities |
|---|---|
| **SUPERADMIN (no org)** | Global system access — master data, all org's data, all backup operations, LLM config, create DGDE model; add global External DB layers and global GIS Server layers |
| **SUPERADMIN (DGDE/PDDE org)** | Treated identically to DGDE/PDDE office users — own-org content only; no rights over subordinate offices |
| **DGDE / PDDE users** | Create and manage own org's projects/areas/documents; view subordinate offices' **published maps** (Map Viewer only); cannot add/edit/delete sub-office content |
| **DEO_ADMIN / CEO_ADMIN / ADEO_ADMIN** | Manage users/orgs within own hierarchy; publish approved survey areas; approve/reject cross-org access requests; download own org backups; add org-scoped GIS Server layers |
| **PDDE_VIEWER** | Read-only access within own command jurisdiction |
| **SDO / SURVEYOR / CHECKER / APPROVER / VIEWER** | Standard survey workflow access; can add org-scoped GIS Server layers for their own organisation |

> **GIS Server Layers:** Any authenticated user can register GIS server connections and add layers. Layers added by a global SUPERADMIN have `organisation = null` and are visible globally. Layers added by any other user are automatically scoped to their own organisation.

---

## Data Access Rules

| Actor | Projects / Survey Areas / Features / Docs | Published Map Viewer | Add / Edit / Delete sub-office content |
|---|---|---|---|
| **DGDE / DGDE-org superadmin** | Own org only | All offices (India-wide) | ✗ Blocked |
| **PDDE / PDDE-org superadmin** | Own org only | Own command subtree | ✗ Blocked |
| **DEO / CEO / ADEO** | Own org only | Own published areas | ✓ Within own org |
| **Any org (approved cross-org)** | Survey areas approved via access request | — | ✗ Read-only |
| **Any user (ProjectShare)** | Projects explicitly shared to them | — | ✗ Read-only |
| **Global superadmin (no org)** | All organisations | All | ✓ All |

---

## Project Structure

```
RakshaGIS/
├── apps/
│   ├── accounts/          # Users, Organisations, RBAC, mandatory TOTP 2FA
│   ├── ai_assistant/      # Ollama/LocalAI chat, RAG, vision extraction, AI report generation, attribute validation
│   ├── backups/           # Backup jobs, schedules, Celery tasks, encryption
│   ├── collaboration/     # WebSocket consumers, JWT middleware, routing
│   ├── core/              # Basemap configs, terrain config, watermark pipeline, terrain vector upload
│   ├── documents/         # File upload, OnlyOffice integration, AI processing, LP-DNA watermarking
│   ├── gis_layers/        # State/District/Taluk/Village master data, boundary import
│   ├── reports/           # Scheduled reports, AI Survey Report Generator
│   ├── survey_projects/   # Projects, Survey Areas, Features, Folders, FeatureComments, Access Requests
│   │   └── access.py      # Central HQ isolation helpers: hq_level(), org_queryset_filter(), ai_project_ids()
│   ├── dashboard/         # Dashboard stats, Office Drilldown (OrgDrilldownView)
│   └── workflow/          # Survey-area state machine, dispute detection, audit log, notifications
├── config/
│   ├── asgi.py            # ASGI application (Channels + ProtocolTypeRouter)
│   ├── wsgi.py            # WSGI fallback
│   ├── celery.py          # Celery configuration
│   ├── settings/
│   │   ├── base.py        # Shared settings
│   │   ├── development.py # Dev overrides (DEBUG=True, etc.)
│   │   └── production.py  # Production settings
│   └── urls.py            # Root URL configuration
├── frontend/              # React 18 + TypeScript SPA (Vite)
│   └── src/
│       ├── features/
│       │   ├── map/               # MapPage, CollabPresence, FeatureCommentThread
│       │   ├── terrain/           # Cesium 3D viewer, DEMAnalysisPanel (16 tools + legend/stats), vector upload
│       │   ├── projects/          # ProjectDetailPage, DisputeModal, etc.
│       │   ├── ai-chat/           # AI chat page with RAG selector
│       │   ├── ai-vision/         # Vision boundary extraction page
│       │   ├── backups/           # Backup management page
│       │   ├── master/            # State/District/Taluk/Village CRUD + Boundary Import
│       │   ├── auth/              # LoginPage with TOTP 2FA setup (QR code + confirm step)
│       │   ├── field/             # FieldCompanionPage — offline PWA, GPS tracking, feature queue
│       │   ├── dashboard/         # OrgDrilldownPage (DGDE → command → DEO hierarchy)
│       │   ├── reports/           # ReportsPage (AI_SUMMARY report type added)
│       │   ├── users/             # User management
│       │   └── organisations/     # Organisation management
│       ├── hooks/
│       │   └── useProjectWebSocket.ts  # Real-time collaboration hook
│       ├── i18n/
│       │   ├── index.ts           # i18next configuration
│       │   └── locales/           # en.json, hi.json, ta.json, te.json, bn.json, kn.json, mr.json
│       ├── components/
│       │   ├── AppLayout.tsx      # Main layout, sidebar (Field Companion + Office Drilldown added)
│       │   └── LanguageSwitcher.tsx
│       ├── utils/
│       │   ├── watermarkDownload.ts  # C2PA + LP-DNA watermark pipeline (posts to /core/watermark-file/)
│       │   └── offlineStore.ts       # IndexedDB helpers for PWA offline cache and feature outbox
│       ├── app/                   # Routes, Zustand store
│       ├── services/              # Axios instance, query keys
│       └── types/                 # Shared TypeScript interfaces
├── deploy/
│   ├── nginx-docker.conf  # Nginx config (HTTP + WebSocket + tile proxies)
│   ├── nginx-terrain.conf # Terrain tile server nginx config
│   ├── prometheus.yml     # Prometheus scrape config
│   └── gunicorn.conf.py   # Gunicorn config (legacy reference)
├── docker-compose.yml     # All services + profiles
├── Dockerfile             # Web application image
├── requirements.txt       # Python dependencies
├── entrypoint.sh          # Container entrypoint (migrations, collectstatic)
├── build.sh               # Build + --import-osm + --save/load-images
├── update.sh              # Quick deploy: backend restart / frontend build+sync / all
├── RakshaGIS.sh           # Service manager (start/stop/backup/restore)
├── setup_terrain.sh       # SRTM DEM download + quantized-mesh conversion
├── scripts/
│   └── generate_terrain_layer.py  # Scans tile dir, writes layer.json with correct available[] index
└── generate_writeup.py    # Generates project writeup .docx
```

---

## Architecture

```
Browser / Client
  └── nginx (:80/:443)  [raksha-edge network — port publishing]
        ├── /api/          → Daphne (ASGI) → Django (4 workers)
        ├── /ws/           → Daphne (ASGI) → Django Channels (WebSocket)
        ├── /static/       → staticfiles volume (direct serve)
        ├── /media/        → media volume (direct serve)
        ├── /tiles/        → pg_tileserv  (MVT vector tiles)
        ├── /osm-tiles/    → osm-tiles    (raster, offline India)
        ├── /terrain-tiles/→ terrain-server (quantized-mesh DEM)
        ├── /onlyoffice/   → OnlyOffice   (document server)
        └── /              → React SPA (static files)

Django Apps  [raksha-net network — internal, no outbound internet]
  ├── accounts          — Users, Organisations, RBAC, 2FA
  ├── core              — Basemap + terrain config + branding
  ├── gis_layers        — State/District/Taluk/Village master + boundary import
  ├── survey_projects   — Projects, Survey Areas, Features, Folders, Access Requests
  ├── documents         — File upload, OnlyOffice, AI processing
  ├── workflow          — State machine, dispute detection, audit log, notifications
  ├── ai_assistant      — Ollama/LocalAI chat, RAG pipeline, vision extraction
  ├── backups           — Encrypted backups, schedules, rotation
  └── collaboration     — WebSocket consumers (real-time editing)

Background Workers (Celery + Redis)
  ├── COG conversion (GeoTIFF → Cloud-Optimized)
  ├── Shapefile import + attribute auto-validation
  ├── AI document processing (pdfplumber + Ollama)
  ├── RAG document embedding (Ollama /api/embed)
  ├── Vision boundary extraction (Ollama /api/chat with images)
  ├── AI Survey Report generation (stats gather → LLM narrative → PDF + .docx)
  ├── Attribute validation (duplicate IDs, missing fields, bbox, zero-area)
  ├── Backup jobs (dumpdata + encrypt + zip)
  ├── Backup rotation (delete expired files)
  └── Scheduled backup runner (check BackupSchedule every hour)

WebSocket (Django Channels + Redis channel layer)
  └── ProjectRoomConsumer per project:
        ├── JWT auth via query param (?token=...)
        ├── Presence tracking (module-level dict)
        ├── Feature locking (module-level dict, auto-release on disconnect)
        └── Broadcasts: feature_created/updated/deleted/locked/unlocked/cursor

Network isolation
  ├── raksha-net  (internal: true) — all backend services; NO outbound internet
  └── raksha-edge (external)       — nginx only; required for port 80/443

Optional services (Docker profiles)
  ├── --profile osm                → osm-tiles (India raster tiles)
  ├── --profile terrain            → terrain-server (SRTM DEM tiles)
  ├── --profile monitoring         → prometheus + grafana
  ├── --profile https              → certbot (Let's Encrypt)
  ├── --profile docker-ollama / docker-ollama-gpu  → Ollama container
  ├── --profile localai / localai-gpu              → LocalAI container
  ├── --profile llamacpp / llamacpp-gpu            → llama.cpp container
  └── --profile anythingllm / anythingllm-gpu     → AnythingLLM container
```

---

## External Data Layers

RakshaGIS supports two types of externally-sourced read-only layers, both accessible from the map toolbar's **Layers & Tools** panel:

| Type | Who can add | Visibility |
|------|-------------|------------|
| **External DB Layers** | SUPERADMIN only | All users (filtered by office level) |
| **GIS Server Layers** | Any authenticated user | Global (SUPERADMIN-added) or org-scoped (all other users) |

---

### External DB Layers (SuperAdmin only)

Renders geometry queried live from a separate PostgreSQL/PostGIS database (e.g. a DGDE operational DB) without copying data into RakshaGIS.

```
External PostGIS DB ──live query (psycopg2)──▶ Django (apps/external_data)
  └─ row-level filter by user's org level ─┘            │ GeoJSON (≤20k features, bbox-aware)
                                                        ▼
                                              Map viewer (OpenLayers) — "Layers & Tools" panel
```

- **Read-only**: no edit/delete/draw on these layers.
- **Org-level row filtering**: DGDE/superadmin see all rows; PDDE/DEO/CEO/ADEO see only rows matching their office code.
- **Per-layer styling**: stroke, fill colour/opacity, QGIS-style fill patterns, and classification (thematic) colouring.
- **Performance**: large layers load by viewport (bbox + spatial index); smaller ones load fully.

#### Admin configuration (SuperAdmin only)

1. **Add the external database** — Settings → External Data → Databases → set host/port/database/schema/user/password, then **Test Connection**. Use a **read-only** DB user.
2. **Register a layer** — External Data → External Layers:

   | Field | Example | Notes |
   |-------|---------|-------|
   | `database` | DGDE Operational DB | the connection above |
   | `schema_name` / `table_name` | `public` / `sp_demap_p2` | source table |
   | `geometry_column` / `geometry_type` / `srid` | `geom` / `MULTIPOLYGON` / `4326` | source geometry |
   | `id_column` / `label_column` | `gid` / `survey_no` | identity + label |
   | `level_filter_fields` | `{"PDDE":"command","DEO":"officeid","CEO":"officeid","ADEO":"officeid"}` | per-level filter column (recommended) |
   | `office_filter_field` | `officeid` | single-column fallback (legacy) |
   | `classification_field` / `classification_colors` | `land_use` / `{…}` | thematic colouring (optional) |
   | `is_active` / `min_zoom` | `true` / `5` | visibility |

3. **Refresh stats** — `POST /api/external/layers/{id}/refresh-stats/` populates `feature_count` and `bbox`.

#### Key endpoints

```
GET  /api/external/layers/                          # active layers (role-filtered)
GET  /api/external/layers/{id}/geojson/?limit=20000 # live, office-filtered GeoJSON
        &bbox=minLon,minLat,maxLon,maxLat           #   viewport filter (spatial index)
        &filter_field=land_use&filter_value=Agri    #   attribute filter
GET  /api/external/layers/{id}/distinct-values/?field=land_use
POST /api/external/layers/{id}/refresh-stats/       # SuperAdmin
GET  /api/external/databases/{id}/tables/           # list spatial tables
```

---

### GIS Server Layers (All Users)

Any authenticated user can register and consume layers from external GIS servers (GeoServer, ArcGIS, MapServer, QGIS Server, etc.) over standard protocols (WMS, WMTS, WFS, ArcGIS Map/Feature Service, XYZ).

#### Visibility scoping

| Added by | `organisation` field | Visible to |
|----------|----------------------|------------|
| SUPERADMIN | `null` (global) | All users across all organisations |
| Any other user | Automatically set to their own org | Users within the same organisation only |

Layers are tagged in the UI: **cyan "Global"** tag for SUPERADMIN-added layers; **purple "[OrgName]"** tag for org-scoped layers.

#### How to use

1. Go to **Map** → click the **Layers & Tools** toolbar button (left side of map).
2. Switch to the **GIS Servers** tab (opens by default for non-SUPERADMIN users).
3. Click **Add Server** to register a GIS server connection (name, type, URL, optional credentials).
4. Use **Discover** on any server card to auto-detect available layers via GetCapabilities.
5. Click any discovered layer tag or use **Add Layer** to register the layer with display name, protocol, and style.
6. Toggle the **Show** switch on any layer to load it onto the map.

#### Layer protocols supported

| Protocol | Type | Use case |
|----------|------|----------|
| WMS | Tile (raster) | GeoServer, QGIS, MapServer raster rendering |
| WMTS | Tile (raster) | Tiled WMS services |
| WFS | Vector | GeoServer, QGIS vector feature queries |
| ArcGIS Map Service | Tile | ArcGIS Server map services |
| ArcGIS Feature Service | Vector | ArcGIS Server feature queries |
| XYZ | Tile | Any XYZ/slippy tile endpoint |

#### Key endpoints

```
GET    /api/external/gis-servers/                         # list server connections
POST   /api/external/gis-servers/                         # register a new server
GET    /api/external/gis-servers/{id}/capabilities/       # auto-discover layers
POST   /api/external/gis-servers/{id}/test/               # test connectivity
GET    /api/external/gis-server-layers/                   # list layers (org-filtered)
POST   /api/external/gis-server-layers/                   # add a layer
GET    /api/external/gis-server-layers/{id}/features/     # proxy WFS/ArcGIS features as GeoJSON
GET    /api/external/gis-server-layers/{id}/tile-config/  # WMS/WMTS params for tile layer
```

---

### Troubleshooting external layers

| Problem | Check |
|---------|-------|
| External DB layer shows 0 features | `is_active=True`? DB connection OK? user's org level set? filter column names correct? |
| GIS server connection fails | URL reachable from container? auth credentials correct? |
| WMS layer shows blank | Check layer name matches exactly; verify CRS (EPSG:4326 or EPSG:3857) |
| Slow external DB layer | Add `GIST` index on geometry + b-tree index on filter column |

> **Security:** External DB credentials are stored in `ExternalDatabase.password`. Use a **read-only** DB account, restrict to SuperAdmins, and protect with firewall/VPN. Row-level filtering is enforced server-side.

---

## Map Printing & High-Resolution Export

RakshaGIS offers three complementary export paths:

| Path | Where | Quality | Use for |
|------|-------|---------|---------|
| **jsPDF + html2canvas** (client) | Map toolbar → Print | Screen DPI | quick previews, layouts with legend / scale bar / north arrow |
| **GeoTIFF / PNG (client)** | Map toolbar → Export TIFF | 150 DPI or 300 DPI | high-resolution raster export including basemap tiles |
| **Mapnik** (server, raster) | Map toolbar → PNG (300+ DPI) | Publication (300+ DPI) | cartographic output direct from PostGIS |

### Quick PDF export (client)
The **Print** action produces a PDF with optional **legend, scale bar, north arrow, title, and coordinate grid** (jsPDF). Instant — no server resources.

### High-resolution GeoTIFF / PNG export (client, 150–300 DPI)

Captures the full map canvas — including basemap raster tiles and all vector layers — at 2× or 3× pixel density, then exports as a georeferenced GeoTIFF (with embedded world-file metadata) or plain PNG.

**Tile-loading fix (v1.1):** At 300 DPI the map must load 3× more tiles than at screen resolution. A `waitForTilesLoaded()` listener is registered *before* `renderSync()` so that `tileloadstart` events are captured as soon as the render triggers tile requests. The export waits for an 800 ms idle, then a 400 ms post-last-tile settle, then a 300 ms final settle before compositing — preventing the blurred basemap that occurred when tiles were still in-flight during canvas capture.

### High-resolution Mapnik export (server)

Mapnik renders directly from PostGIS at arbitrary resolution using XML map styles.

**Install (native):**
```bash
bash install-mapnik.sh                 # system libmapnik + python-mapnik
# then edit the DB credentials in the style file:
nano services/mapnik/styles/boundaries.xml   # host/user/password/dbname
```
In Docker, Mapnik is built into the image (see `Dockerfile`); set the style `host` to `host.docker.internal` (or the DB service name) and rebuild.

**Files:**
| Purpose | Path |
|---------|------|
| Map styles (XML) | `services/mapnik/styles/` (default `boundaries.xml`) |
| Service layer | `apps/core/services/mapnik_service.py` |
| API | `apps/core/views.py` (`export-map`, `map-styles`) |
| React modal | `frontend/src/features/map/MapExportModal.tsx` |

**API:**
```bash
# List available styles
curl /api/core/map-styles/ -H "Authorization: Bearer TOKEN"
# → {"styles": ["boundaries", ...], "count": N}

# Render a PNG
curl -X POST /api/core/export-map/ -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"width":1200,"height":800,"zoom":10,"center_lon":78.5,"center_lat":20.5,"style":"boundaries"}' \
  -o map.png
```

**Add a style:** copy `boundaries.xml`, point its `<Datasource>` at your table/query, define `<PolygonSymbolizer>`/`<LineSymbolizer>`/`<TextSymbolizer>` rules (with optional `<Filter>` for conditional colouring). It appears automatically in `map-styles`.

**Tuning:** add `GIST` indexes on geometry, keep `<Datasource>` queries simple, and optionally `@cache_page` the export view.

> Other approaches evaluated (Puppeteer/Playwright, MapLibre GL export, ReportLab, GeoServer WPS) are documented in `docs/archive/MAP_PRINTING_OPTIONS.md`. Mapnik is the chosen path for publication-grade, high-volume output.

---

## Boundary Extraction & Review

RakshaGIS can extract parcel polygons from drone/satellite **GeoTIFFs** and from scanned maps, then hand them to a dedicated review editor.

- **Classical GIS pipeline** (default, no GPU): edge detection → morphological gap-closing → connected components → GDAL polygonize. Deterministic and fast; best-effort **Survey-Number OCR** (PaddleOCR) fills the `survey_number` attribute where readable, blank otherwise.
- **AI Vision** / **Advanced AI Vision Pipeline** (GPU): LLaVA / SAM + U-Net++ + PaddleOCR for segmentation and survey-number recovery.

After a Classical extraction completes the user is taken to a **standalone Boundary Review viewer** (separate from the main map) that overlays the GeoTIFF and the extracted polygons and provides **reshape, split, merge, add, and delete** tools plus an editable **Survey Number** per polygon. Reviewed polygons are saved to an existing or new **Survey Area**.

Entry points: **AI → GeoTiff Polygon Extraction** (`/ai-vision`) → run Classical → auto-redirect to `/boundary-review/:jobId`; or the **Review** button in the extraction history.

---

## Offline PWA Field Companion

The Field Companion (`/field-companion`) is a Progressive Web App (PWA) designed for surveyors who work in areas with intermittent or no connectivity.

### Features

- **Offline-first OpenLayers map** — project layers are cached to IndexedDB when online; the map continues to work without a network
- **Project caching** — tap "Cache for offline" on any project to store its features, survey areas, and attribute templates locally
- **GPS tracking** — real-time position indicator; tap any point on the map to add a geo-referenced note with automatically recorded coordinates
- **Offline feature queue** — new features added while offline are stored in a local outbox (IndexedDB) and synced automatically when connectivity is restored
- **Pending-sync badge** — the PWA icon on the Map toolbar shows the count of features waiting to sync
- **Auto-sync on reconnect** — when the browser regains connectivity, the outbox flushes to the backend (`POST /api/projects/features/`) without user intervention

### Architecture

```
Browser (service worker)
  ├── Cache API → tiles, static assets
  ├── IndexedDB (offlineStore.ts)
  │     ├── projects       (cached project + features)
  │     ├── feature_outbox (pending creates)
  │     └── settings       (last project, GPS state)
  └── Online auto-sync (connectivity event → flush outbox)
```

### Access

The Field Companion is available from the sidebar menu (**Field Companion** → EnvironmentOutlined icon) or directly at `/field-companion`. No special role is required.

---

## API Reference (additions)

See the developer workflow below (full history in `docs/archive/CONTRIBUTING.md`).

1. **Local setup** — run backend services in Docker, then Django + Celery + Vite locally:
   ```bash
   docker compose up -d db redis onlyoffice
   python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
   cp .env.example .env          # point DATABASE_URL/REDIS_URL at localhost
   python manage.py migrate && python manage.py createsuperuser
   python manage.py runserver                       # API :8000
   celery -A config worker -l info                  # background tasks
   cd frontend && npm install && npm run dev        # UI :5173 (proxies API)
   ```
2. **Branch** off the default branch; keep changes focused.
3. **Code style** — match surrounding code. Python: Django/DRF conventions, type hints where used. Frontend: TypeScript + React + AntD + OpenLayers; reuse existing components and `@/services/api`.
4. **Migrations** — commit Django migrations for any model change (`python manage.py makemigrations`).
5. **Build check** — `cd frontend && npm run build` must pass before a PR.
6. **Commits/PRs** — clear messages; describe the change, testing done, and any migration/runtime steps.

---

## Production Deployment Checklist

Beyond [Installation](#installation), harden before going live (full guide in `docs/archive/DEPLOYMENT.md`):

- **Secrets** — set a strong `DJANGO_SECRET_KEY`, `ONLYOFFICE_JWT_SECRET`, DB and backup-encryption passwords; never reuse `.env.example` values.
- **Hosts/TLS** — set `ALLOWED_HOSTS`/`CSRF_TRUSTED_ORIGINS`; terminate TLS at nginx (see [HTTPS / TLS](#https--tls)) and set `SECURE_*` cookies.
- **Database** — dedicated PostGIS volume on persistent storage; restrict network access; schedule [backups](#backup--recovery) with rotation + off-host copy.
- **Services** — run Django under **Daphne/ASGI** (WebSockets), Celery worker + beat, Redis; confirm `docker compose ps` is all healthy.
- **Storage paths** — point `DATA_DIR`/media/static at persistent host paths; verify `collectstatic`/frontend build are deployed.
- **Resources** — size CPU/RAM for COG conversion, Mapnik, and (optional) AI/terrain; keep Ollama/terrain on their own profiles.
- **Verify** — log in, load the map, run an export, open a document in OnlyOffice, trigger a backup, and confirm a restore on a staging copy.

---

## Troubleshooting

### Web container keeps restarting

```bash
# Check logs for the error
docker compose logs web --tail=50

# Common cause: database not ready
./RakshaGIS.sh status

# Try running migrations manually
docker compose run --rm web python manage.py migrate
```

### OnlyOffice shows "document loading failed"

```bash
# Verify ONLYOFFICE_JWT_SECRET is set in .env
grep ONLYOFFICE_JWT_SECRET .env

# Check OnlyOffice is healthy
docker compose ps onlyoffice

# Check logs
docker compose logs onlyoffice --tail=30
```

### AI Chat shows "Ollama not reachable"

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# If using Docker Ollama:
docker compose ps ollama
docker compose logs ollama --tail=20

# If using host Ollama, verify URL in .env:
# OLLAMA_HOST_URL=http://host.docker.internal:11434 (Docker Desktop / WSL2)
# OLLAMA_LOCAL_URL=http://localhost:11434 (native Linux)
```

### WebSocket (real-time collaboration) not connecting

```bash
# Check Daphne is running (not gunicorn)
docker compose logs web --tail=10 | grep -E "Daphne|daphne|Starting server"

# Check Redis is running
docker compose ps redis

# Check channel layer
docker compose exec web python manage.py shell -c "
from channels.layers import get_channel_layer
import asyncio
cl = get_channel_layer()
asyncio.run(cl.group_add('test', 'ch'))
print('OK')
"
```

### 3D Terrain viewer shows flat terrain

The terrain viewer works without DEM data, but elevation queries will return 0. To enable real terrain:

1. Run `./setup_terrain.sh --all` to download and convert SRTM data
2. Start: `docker compose --profile terrain up -d terrain-server`
3. Add to `.env`: `TERRAIN_TILE_URL=/terrain-tiles`
4. Restart: `./RakshaGIS.sh restart`

Alternatively, set `CESIUM_ION_TOKEN=<your_token>` in `.env` for online Cesium World Terrain.

### Backup download fails with "Decryption failed"

The encryption key may have changed. The key is stored at `$BACKUP_DIR/.backup_key`. If this file was deleted or the `BACKUP_ENCRYPTION_KEY` env var changed, older backups cannot be decrypted. Always back up the `.backup_key` file securely.

### MapPage shows "Failed to load features"

```bash
# Check the API is accessible
curl http://localhost/api/projects/ -H "Authorization: Bearer <token>"

# Check PostGIS extension
docker compose exec db psql -U raksha -d rakshagis -c "SELECT PostGIS_Version();"
```

### Build fails with "Permission denied" on migrations

**WSL2 / Docker Desktop issue**: When `./build.sh` runs, the container user (raksha) cannot write to the migrations directory mounted from the host.

**Solution**: Migrations are now created on the host before deployment:

```bash
# If you added new Django models:
python manage.py makemigrations

# Then run the build:
./build.sh

# The build will apply migrations automatically
```

For details, see [docs/archive/DOCKER_BUILD_FIXES.md](docs/archive/DOCKER_BUILD_FIXES.md).

---

## Maintenance Notes & Resolved Issues

A condensed history of notable fixes. The original per-issue notes are preserved under [`docs/archive/`](docs/archive/).

| Area | Symptom | Resolution |
|------|---------|------------|
| **Cesium (3D)** | Blank globe / `Cannot find module` for Cesium assets in TerrainPage | Correct Cesium static asset path + import; `fix-cesium-path.sh` runs in the build. See `CESIUM_ASSET_PATH_FIX.md`, `CESIUM_IMPORT_FIX.md`. |
| **3D Terrain** | Features draped wrong / globe halts after "Load Features" | Drape polygons (clamp-to-ground) instead of extrude+clamp; guard null `layer_name`; per-feature try/catch. See `TERRAIN_FIX_COMPLETE.md`. |
| **3D Terrain rendering** | Terrain viewer showed flat 2D — no elevation relief visible | nginx `proxy_pass` with variable doesn't rewrite URI; added `rewrite ^/terrain-tiles/(.*)$ /$1 break;` in `nginx-docker.conf`. |
| **Cesium availability** | "terrain availability error" on load | `layer.json` lacked the `available` array; `scripts/generate_terrain_layer.py` now scans the tile tree and writes the correct index. |
| **Slope analysis** | "Invalid grid data" error for any grid larger than ~22×22 | `ElevationLookupView` was capped at 500 points; raised to 5,000 so a 50×50 grid works. |
| **OTP validation** | TOTP code rejected on login | Root cause: device existed with a different secret than what the authenticator scanned. Added `valid_window=2` (±60 s tolerance) and stripped spaces before comparison. |
| **OnlyOffice save callback** | 400 errors on document save | `nginx` was not in `ALLOWED_HOSTS`; fix: `ALLOWED_HOSTS=localhost,127.0.0.1,nginx` and `docker compose up -d web celery` (NOT docker restart — env is baked at container creation). |
| **fiona ≥1.9 geometry** | `Object of type Geometry is not JSON serializable` in vector upload / shapefile import | Used `from fiona.model import to_dict as _to_dict; geom = _to_dict(geom)` before JSON serialisation. |
| **DGDE/PDDE seeing sub-office data** | HQ and org-attached superadmins bypassed org filtering | `hq_level()` + `org_queryset_filter()` now applied universally; superadmin role no longer exempt when attached to an HQ org. Affects all viewsets, dashboard, search, AI, reports, and workflow. |
| **DEO sub-office stats in drilldown** | DEO drilldown showed CEO/ADEO data | Replaced `_descendant_ids()` with `_scope_ids()` that stops descent at DEO level. |
| **"Send Now" not working** | Manual report trigger skipped | Only sent due schedules; fix: force `next_run=None` before triggering. |
| **OnlyOffice** | Document editor opened in a cramped modal | Open documents in a new browser tab. See `ONLYOFFICE_FIX_SUMMARY.md`. |
| **Docker build** | `<none>` image tags, migration permission errors on WSL2 | Fixed image naming + entrypoint permissions. See `DOCKER_BUILD_FIXES.md`. |
| **Mapnik** | `import mapnik` fails / export 503 | Install system `libmapnik` + `python-mapnik` (baked into the Docker image); see [Map Printing](#map-printing--high-resolution-export). |
| **300 DPI TIFF export** | Basemap tiles appear blurred at 300 DPI | `waitForTilesLoaded()` is now attached *before* `renderSync()` so tile requests are caught as they fire; waits for 800 ms idle + 400 ms post-last-tile + 300 ms settle before compositing. |
| **GIS Server Layers** | Add Layer / Add Server buttons not visible to non-SUPERADMIN users | Permission check changed from `ADMIN_ROLES` list to `!!user` — any authenticated user can now add GIS Server layers. Default tab in Layers & Tools panel changed to GIS Servers for non-SUPERADMIN users. |

For broader status snapshots see `docs/archive/IMPLEMENTATION_SUMMARY.md`, `FIXES_COMPLETED_SUMMARY.md`, and `SETUP_PROGRESS.md`.

---

## Project Background (DGDE)

*(Condensed from the formal write-up — full version: `RakshaGIS_Project_WriteUp.docx`.)*

**Objective.** Defence-estate land management historically relied on paper maps, disconnected spreadsheets, and manual review — causing delays, inconsistencies, and security risks. RakshaGIS digitises field surveys, enforces an internal approval workflow, isolates data by office, and publishes approved maps — entirely on-premise with **zero cloud/internet dependency** after installation.

**Expected outcomes / benefits.**
- Faster, paperless surveys with consistent, georeferenced records.
- Auditable survey-area-wise approval (Draft → Submitted → Under Review → Approved → Published).
- Strict role- and office-level data isolation with controlled cross-office access.
- In-browser document editing, AI-assisted document processing, and high-resolution map publishing in one platform.
- Air-gap–friendly operation suitable for secure defence networks.

### Roadmap & feature status

Several items first identified as "future scope" are now **delivered**:

| Capability | Status |
|------------|--------|
| HTTPS with internal CA (Nginx TLS) | ✅ Prepared — `https` profile + certbot ready; supply the CA cert to activate |
| Prometheus / Grafana monitoring | ✅ `/metrics/` + `monitoring` profile shipped (import DGDE dashboards) |
| Automated boundary dispute detection | ✅ Pre-submission PostGIS overlap check vs other orgs' PUBLISHED features (`DisputeReport`) |
| Advanced AI integration | ✅ GeoTIFF/scanned-map parcel extraction + Survey-Number OCR; local-LLM training-export / fine-tune tooling |
| Admin boundary data load | ✅ State/District/Taluk/Village master + shapefile import |
| 3D terrain & elevation overlay | ✅ Cesium viewer — elevation/profile/slope, 16 DEM analysis tools, vector overlay, C2PA-watermarked PNG export |
| Real-time collaborative editing | ✅ WebSocket (Channels/Daphne) concurrent editing + presence |
| Multi-language UI | ✅ English, Hindi, Tamil, Telugu, Bengali, Kannada, Marathi |
| Automated DR backups | ✅ Encrypted PostgreSQL dumps + rotation (off-site replication pending) |
| Regulatory reporting | ◑ Survey-area `.docx` + proximity/encroachment reports done; ministry-format templates in progress |
| GIS Server Layers (all-user) | ✅ Any authenticated user can add WMS/WFS/ArcGIS/XYZ server layers; org-scoped or global (SUPERADMIN) |
| 300 DPI map export | ✅ Client-side GeoTIFF/PNG export at 300 DPI with tile-load wait before canvas composite |
| Mandatory 2FA (TOTP) | ✅ First-login QR setup + OTP enforcement on every login; no bypass |
| C2PA + LP-DNA watermarking | ✅ All terrain exports, uploaded documents, and report PDFs carry provenance watermarks |
| AI Survey Report Generator | ✅ LLM-authored narrative PDF + .docx from project data |
| Attribute Auto-Validator | ✅ Post-import checks: duplicate IDs, missing fields, zero-area polygons, out-of-India bbox |
| Offline PWA Field Companion | ✅ IndexedDB cache, GPS tracking, offline feature queue, auto-sync on reconnect |
| Per-Feature Comment Threads | ✅ Threaded discussion on any GIS feature with role-coloured tags |
| Office Drilldown Dashboard | ✅ DGDE → command → DEO aggregates with breadcrumb navigation |
| Strict HQ data isolation | ✅ DGDE/PDDE and org-attached superadmins see only own-org content; sub-office data never leaks |
| 3D Vector File Upload | ✅ Shapefile/GeoJSON/KML/KMZ/GeoPackage loaded as Cesium 3D overlay |

**Still planned:** DILRMP (national land registry) connectors · PKI / smart-card (mutual-TLS) authentication · off-site backup replication to NIC Meghraj · ministry-prescribed report templates.

---

## Licence

Developed for DGDE — Directorate General of Defence Estates, Government of India. All rights reserved.
