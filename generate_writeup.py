"""
Generate RakshaGIS Project Write-Up as a Word (.docx) document.
Run: python3 generate_writeup.py
Output: RakshaGIS_Project_WriteUp.docx
"""

from docx import Document
from docx.shared import Pt, Inches, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import datetime

# ── Colour palette (hex strings) ─────────────────────────────────────────────
NAVY      = '0A1E3C'
OLIVE     = '4A6A00'
ACCENT    = '1F5EA8'
LIGHT_BG  = 'F0F4F8'
WHITE     = 'FFFFFF'
MID_GRAY  = '555555'
DARK_TEXT = '1A1A2E'


def rgb(hex_str: str) -> RGBColor:
    """Convert 6-char hex string to RGBColor."""
    return RGBColor(int(hex_str[0:2], 16), int(hex_str[2:4], 16), int(hex_str[4:6], 16))


def set_cell_bg(cell, hex_color: str):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hex_color)
    tcPr.append(shd)


def add_h_rule(doc, color=NAVY, thick='6'):
    """Add a full-width horizontal rule paragraph."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after  = Pt(8)
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), thick)
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), color)
    pBdr.append(bottom)
    pPr.append(pBdr)
    return p


def add_heading(doc, text, level=1):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14 if level == 1 else 8)
    p.paragraph_format.space_after  = Pt(6)
    run = p.add_run(text)
    run.bold = True
    if level == 1:
        run.font.size = Pt(15)
        run.font.color.rgb = rgb(NAVY)
        # underline rule
        pPr = p._p.get_or_add_pPr()
        pBdr = OxmlElement('w:pBdr')
        bottom = OxmlElement('w:bottom')
        bottom.set(qn('w:val'), 'single')
        bottom.set(qn('w:sz'), '6')
        bottom.set(qn('w:space'), '1')
        bottom.set(qn('w:color'), NAVY)
        pBdr.append(bottom)
        pPr.append(pBdr)
    elif level == 2:
        run.font.size = Pt(12)
        run.font.color.rgb = rgb(ACCENT)
    else:
        run.font.size = Pt(11)
        run.font.color.rgb = rgb(OLIVE)
    return p


def add_body(doc, text):
    p = doc.add_paragraph(text)
    p.paragraph_format.space_after  = Pt(5)
    p.paragraph_format.space_before = Pt(2)
    for run in p.runs:
        run.font.size = Pt(10.5)
        run.font.color.rgb = rgb(DARK_TEXT)
    return p


def add_bullet(doc, label, detail, label_color=ACCENT):
    p = doc.add_paragraph(style='List Bullet')
    p.paragraph_format.space_after  = Pt(4)
    p.paragraph_format.space_before = Pt(1)
    r1 = p.add_run(f'{label}: ')
    r1.bold = True
    r1.font.size = Pt(10.5)
    r1.font.color.rgb = rgb(label_color)
    r2 = p.add_run(detail)
    r2.font.size = Pt(10.5)
    r2.font.color.rgb = rgb(DARK_TEXT)
    return p


def add_plain_bullet(doc, text):
    p = doc.add_paragraph(style='List Bullet')
    p.paragraph_format.space_after  = Pt(3)
    p.paragraph_format.space_before = Pt(1)
    run = p.add_run(text)
    run.font.size = Pt(10.5)
    run.font.color.rgb = rgb(DARK_TEXT)
    return p


def add_table(doc, rows, header=None, col_widths=None):
    cols = len(rows[0]) if rows else 2
    table = doc.add_table(rows=0, cols=cols)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.LEFT

    if header:
        hrow = table.add_row()
        for i, h in enumerate(header):
            cell = hrow.cells[i]
            set_cell_bg(cell, NAVY)
            p = cell.paragraphs[0]
            run = p.add_run(h)
            run.bold = True
            run.font.size = Pt(10)
            run.font.color.rgb = rgb(WHITE)

    for ridx, row_data in enumerate(rows):
        r = table.add_row()
        bg = LIGHT_BG if ridx % 2 == 0 else WHITE
        for cidx, val in enumerate(row_data):
            cell = r.cells[cidx]
            set_cell_bg(cell, bg)
            p = cell.paragraphs[0]
            run = p.add_run(val)
            run.font.size = Pt(9.5)
            run.font.color.rgb = rgb(DARK_TEXT)
            if cidx == 0:
                run.bold = True

    if col_widths:
        for row in table.rows:
            for i, w in enumerate(col_widths):
                if i < len(row.cells):
                    row.cells[i].width = Inches(w)

    doc.add_paragraph()
    return table


# ─────────────────────────────────────────────────────────────────────────────
#  BUILD THE DOCUMENT
# ─────────────────────────────────────────────────────────────────────────────
doc = Document()

# Page margins
for section in doc.sections:
    section.top_margin    = Cm(2.0)
    section.bottom_margin = Cm(2.0)
    section.left_margin   = Cm(2.5)
    section.right_margin  = Cm(2.5)

doc.styles['Normal'].font.name = 'Calibri'
doc.styles['Normal'].font.size = Pt(10.5)

# ── Cover block ───────────────────────────────────────────────────────────────
title_p = doc.add_paragraph()
title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
title_p.paragraph_format.space_before = Pt(4)
title_p.paragraph_format.space_after  = Pt(0)
r1 = title_p.add_run('RAKSHA')
r1.bold = True; r1.font.size = Pt(36); r1.font.color.rgb = rgb(NAVY)
r2 = title_p.add_run('GIS')
r2.bold = True; r2.font.size = Pt(36); r2.font.color.rgb = rgb(ACCENT)

sub = doc.add_paragraph('Defence Estate GIS Survey Platform')
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
sub.paragraph_format.space_after = Pt(2)
for run in sub.runs:
    run.font.size = Pt(14); run.font.color.rgb = rgb(OLIVE); run.bold = True

org_p = doc.add_paragraph('Directorate General of Defence Estates (DGDE)  |  Government of India')
org_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
org_p.paragraph_format.space_after = Pt(2)
for run in org_p.runs:
    run.font.size = Pt(11); run.font.color.rgb = rgb(MID_GRAY)

date_p = doc.add_paragraph(datetime.date.today().strftime('%B %Y'))
date_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
date_p.paragraph_format.space_after = Pt(12)
for run in date_p.runs:
    run.font.size = Pt(10); run.font.color.rgb = rgb(MID_GRAY)

add_h_rule(doc, NAVY, '12')

# ── 1. Project Title ──────────────────────────────────────────────────────────
add_heading(doc, '1. Project Title', level=1)

t = doc.add_table(rows=1, cols=1)
t.style = 'Table Grid'
cell = t.rows[0].cells[0]
set_cell_bg(cell, NAVY)
cell.width = Inches(6.2)
p = cell.paragraphs[0]
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('RakshaGIS — Defence Estate Geographic Information System & Survey Platform')
run.bold = True; run.font.size = Pt(12); run.font.color.rgb = rgb(WHITE)
doc.add_paragraph()

add_body(doc,
    'RakshaGIS is a full-stack, self-hosted enterprise GIS platform developed for the Directorate '
    'General of Defence Estates (DGDE) to digitise, manage, review, and publish defence land surveys '
    'across India. The system consolidates field surveying, internal approval workflows, AI-assisted '
    'document processing, and map publishing into a single role-gated application — hosted entirely '
    'on-premise with no dependency on commercial cloud services.')

# ── 2. Objective ──────────────────────────────────────────────────────────────
add_heading(doc, '2. Objective of the Project', level=1)

add_body(doc,
    'Defence estate land management has historically relied on paper maps, disconnected spreadsheets, '
    'and manual review processes — creating delays, data inconsistencies, and security risks. '
    'RakshaGIS was commissioned to address these challenges with the following objectives:')

for label, detail in [
    ('Digitise land surveys',
     'Replace paper-based field surveys with an interactive web GIS that lets authorised surveyors draw, '
     'annotate, and submit georeferenced features directly from their workstations.'),
    ('Enforce a formal approval chain',
     'Implement a role-based state machine (Draft → Submitted → Under Review → Approved → Published) '
     'so that no survey data reaches the public record without passing through Checker and Approver review.'),
    ('Maintain data sovereignty',
     'Keep all spatial data, documents, and AI inference within DGDE infrastructure — '
     'no data ever leaves the on-premise deployment.'),
    ('Provide spatial analytics',
     'Enable buffer analysis, topology checking, and version comparison in the browser, '
     'eliminating the need for separate GIS software licences such as ArcGIS.'),
    ('AI-assisted reporting',
     'Automatically summarise uploaded survey documents and generate structured PDF reports '
     'using a local large language model (Ollama) — without internet access or API subscriptions.'),
    ('Scalable multi-organisation support',
     'Support a five-level organisational hierarchy (DGDE → PDDE → DEO → CEO → ADEO) '
     'with per-organisation row-level data isolation and delegated administration.'),
]:
    add_bullet(doc, label, detail, ACCENT)

# ── 3. Key Features / Work Done ───────────────────────────────────────────────
add_heading(doc, '3. Key Features / Work Done', level=1)

# 3.1
add_heading(doc, '3.1  Interactive Map & Spatial Analysis', level=2)
for text in [
    'Multi-basemap support — OSM, XYZ tile layers, WMS/WMTS, and Bhuvan (ISRO) satellite imagery.',
    'Feature drawing with snapping: Point, Line, and Polygon tools with snap-to-vertex and live area/perimeter feedback while drawing.',
    'Edit existing features — move and reshape vertices; changes are automatically persisted to the database.',
    'Box Select tool — drag a rectangle to highlight features; selected count shown in an overlay badge.',
    'Identify tool — click any feature to inspect all attributes in a side drawer.',
    'Buffer Analysis — N configurable distance rings (metres/kilometres); PostGIS geographically-accurate buffer intersected against all defence parcels; results in a colour-coded tabbed modal with mini-map; downloadable as Excel (one sheet per ring) and PDF.',
    'Topology Checker — detects invalid geometries and overlapping parcels via PostGIS ST_IsValid and ST_Intersects; issues listed in a modal with parcel identifiers.',
    'Measure tool — real-time line length display as the user draws.',
    'Cloud-Optimized GeoTIFF (COG) overlay — upload satellite imagery; Celery converts to COG; per-layer opacity and visibility controls.',
    'Shapefile import — upload a zipped .shp archive; background Celery task parses features and bulk-creates them into the selected project.',
    'Attribute Table Panel — bottom-docked spreadsheet of all project features; inline attribute editing; Field Calculator with ${field} expression support; CSV export; double-click row zooms the map to that feature.',
    'Print to PDF — jsPDF A4/A3/Letter layout with captured map canvas, north arrow, scale bar, legend, optional coordinate grid, and DGDE-branded header/footer.',
    'Map Bookmarks — save and recall named map extents stored in localStorage.',
    'Go-to Coordinate — jump directly to any Lat/Lon position.',
    'Per-layer symbology — colour picker per layer name; label toggle renders feature IDs as map text.',
    'Admin boundary tile overlay from pg_tileserv (MapVector Tile) showing District boundaries.',
    'Undo last drawn feature — removes from map source and calls DELETE on the backend.',
]:
    add_plain_bullet(doc, text)

# 3.2
add_heading(doc, '3.2  Survey Workflow & Versioning', level=2)
for text in [
    'State machine: DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → PUBLISHED with RETURNED return paths at each stage.',
    'Role-based transitions: only the correct role can advance or return a project at each stage.',
    'Versioned layer folders: Phase → Zone → Year → Ver-I / Ver-II / … / Final, auto-created on first use.',
    'Auto-versioning: active version detected or created automatically when an SDO opens a project; one-click next-version creation.',
    'Final folder auto-created and populated (features copied) when a project is approved.',
    'Version comparison: split-screen map view comparing two VERSION folders side-by-side with shared pan/zoom.',
    'Project sharing: grant read access to specific users outside the creating organisation.',
    'Full audit log: every state transition, feature edit, and admin action recorded with actor, timestamp, and comment.',
    'In-app notifications: users are notified when a project is submitted, returned, or approved.',
]:
    add_plain_bullet(doc, text)

# 3.3
add_heading(doc, '3.3  User & Organisation Management', level=2)
for text in [
    'Five-level organisation hierarchy: DGDE → PDDE → DEO → CEO → ADEO.',
    'Eight distinct roles with fine-grained permission classes on every API endpoint.',
    'Organisation records extended with Office ID, Officer Name, contact fields, and State/District linkage with cascade-validated dropdowns.',
    'Admin-role protection: DEO/CEO/ADEO/SUPERADMIN accounts cannot be deleted or deactivated — prevents lockout.',
    'Force-logout action sets is_active=False; JWT tokens become invalid immediately without token blacklist overhead.',
    'Password management: users change own password with current-password verification; admins set any non-admin user\'s password.',
]:
    add_plain_bullet(doc, text)

# 3.4
add_heading(doc, '3.4  Master Data Management (SuperAdmin)', level=2)
for text in [
    'Full CRUD for State, District, Taluk, and Village with cascading dropdowns.',
    'PostGIS geometry fields on each hierarchy level — boundaries can be visualised on the map.',
    'SUPERADMIN-only access enforced at API and UI level.',
]:
    add_plain_bullet(doc, text)

# 3.5
add_heading(doc, '3.5  Documents & AI Assistant', level=2)
for text in [
    'Per-project document upload (PDF, images) with MIME-type validation using python-magic.',
    'Background AI processing via Ollama — text extracted by pdfplumber, summarised by the local LLM.',
    'Auto-generated structured PDF survey report per project.',
    'Interactive chat interface: users ask free-text questions; the local LLM answers with project document context.',
    'All AI inference runs on-premise — no data leaves the deployment host.',
]:
    add_plain_bullet(doc, text)

# 3.6
add_heading(doc, '3.6  Infrastructure & DevOps', level=2)
for text in [
    'Fully containerised via Docker Compose: PostgreSQL/PostGIS, Redis, Celery workers, Gunicorn, Nginx, pg_tileserv, Ollama, Prometheus, Grafana.',
    'build.sh — smart Docker image build that skips rebuilding when Dockerfile and requirements are unchanged (SHA-256 hash comparison).',
    'RakshaGIS.sh — one-command service manager: start, stop, status, logs, backup, restore, Django management commands.',
    'Prometheus + Grafana dashboards for request rates, error rates, and database query counts.',
    'Certbot integration in docker-compose for automatic HTTPS certificate renewal.',
    'Layer exports: GeoJSON, Shapefile, CSV, KML, GeoPackage via Fiona/Shapely.',
]:
    add_plain_bullet(doc, text)

# ── 4. Technologies / Tools Used ─────────────────────────────────────────────
add_heading(doc, '4. Technologies / Tools Used', level=1)

tech_rows = [
    ('Backend framework',    'Python 3.11 + Django 4.2',         'REST API, ORM, authentication'),
    ('REST API layer',       'Django REST Framework 3.15',        'Serialisers, viewsets, permissions'),
    ('Spatial database',     'PostgreSQL 16 + PostGIS 3.4',       'Geometry storage, spatial queries, topology'),
    ('Async task queue',     'Celery 5.3 + Redis 7',              'COG conversion, shapefile import, AI tasks'),
    ('Map tile server',      'pg_tileserv',                       'MVT admin boundary tiles from PostGIS'),
    ('AI / LLM inference',   'Ollama (local — e.g. Llama 3.2)',  'Document summarisation, chat, report generation'),
    ('PDF text extraction',  'pdfplumber 0.11',                   'Extracts text from uploaded survey PDFs'),
    ('GIS import/export',    'Fiona 1.9 + Shapely 2.0',          'Shapefile I/O, GeoJSON, KML, GeoPackage'),
    ('HTTP client',          'httpx 0.27',                        'Ollama API calls from Django'),
    ('Frontend framework',   'React 18 + TypeScript + Vite',     'SPA, type safety, fast HMR builds'),
    ('Map library',          'OpenLayers 10.2',                   'Interactive map, vector/raster/MVT layers'),
    ('UI component library', 'Ant Design 5.20',                   'Tables, forms, modals, drawers, pickers'),
    ('State management',     'Zustand 4.5 + TanStack Query 5',   'Global UI state, server-state caching'),
    ('PDF generation',       'jsPDF 4.2 + jspdf-autotable 5',    'Print layout, buffer analysis PDF export'),
    ('Excel export',         'SheetJS (xlsx) 0.18',              'Buffer analysis Excel workbook'),
    ('Map canvas capture',   'html2canvas 1.4',                   'OL canvas to image for PDF embedding'),
    ('COG display',          'geotiff.js 3.0.5',                  'WebGLTileLayer Cloud-Optimized GeoTIFF'),
    ('Authentication',       'SimpleJWT 5.3',                     'Short-lived access + rotating refresh tokens'),
    ('Monitoring',           'Prometheus + Grafana',              'Metrics collection, dashboards, alerting'),
    ('Web server',           'Nginx + Gunicorn (4 workers)',      'Reverse proxy, static file serving, HTTPS'),
    ('Containerisation',     'Docker 24 + Docker Compose v2',    'Isolated, reproducible on-premise deployment'),
    ('API documentation',    'drf-spectacular 0.27',              'OpenAPI 3 schema + Swagger UI'),
    ('File validation',      'python-magic 0.4',                  'MIME-type check on all uploaded files'),
]

add_table(doc, tech_rows,
          header=('Category', 'Technology / Version', 'Purpose'),
          col_widths=[1.6, 2.2, 2.8])

# ── 5. Expected Outcomes / Benefits ──────────────────────────────────────────
add_heading(doc, '5. Expected Outcomes / Benefits', level=1)

for label, detail in [
    ('End-to-end digital survey workflow',
     'Eliminates paper-based submission and manual data entry. Surveys are drawn, reviewed, and published '
     'entirely within the platform — reducing processing time from weeks to days.'),
    ('Accurate, versioned spatial data',
     'Every edit is tied to a named version (Ver-I, Ver-II, Final); no data is overwritten, '
     'enabling full roll-back and side-by-side version comparison.'),
    ('Enforced approval chain',
     'The state machine prevents publication without Checker and Approver sign-off, '
     'reducing the risk of unauthorised or incomplete surveys entering the public record.'),
    ('Data sovereignty and security',
     'All data, including AI inference, remains within DGDE infrastructure. '
     'Role-based access and row-level isolation prevent cross-organisation data leakage.'),
    ('Reduced GIS software dependency',
     'Buffer analysis, topology checking, feature editing, print-to-PDF, and attribute management — '
     'capabilities previously requiring ArcGIS licences — are now available in any modern browser.'),
    ('AI-assisted productivity',
     'Automatic document summarisation and report generation reduce the time an Approver needs '
     'to review a project from hours to minutes.'),
    ('Operational visibility',
     'Prometheus and Grafana dashboards give IT staff real-time insight into system health; '
     'the audit log provides a complete chain of custody for every record.'),
    ('Low operational overhead',
     'Docker Compose deployment, the smart build script, and the single-command service manager '
     'allow a small IT team to maintain the platform without specialist DevOps knowledge.'),
]:
    add_bullet(doc, label, detail, ACCENT)

# ── 6. Future Scope ───────────────────────────────────────────────────────────
add_heading(doc, '6. Future Scope', level=1)

add_body(doc,
    'The current platform provides a strong foundation for defence estate management. '
    'The following enhancements are planned or recommended for future iterations:')

for label, detail in [
    ('Mobile field surveying app',
     'A Progressive Web App (PWA) or React Native client for GPS-assisted feature capture '
     'in the field with offline sync on reconnection.'),
    ('Automated boundary dispute detection',
     'Cross-project spatial analysis to flag when newly submitted features overlap with '
     'PUBLISHED features from other organisations — surfaced as a pre-submission check.'),
    ('Advanced AI integration',
     'Fine-tuning the local LLM on historical DGDE survey documents for domain-specific accuracy; '
     'adding vision models to auto-extract parcel boundaries from scanned paper maps.'),
    ('3D terrain and elevation overlay',
     'Integration of SRTM/Cartosat DEM data for 3D map views and slope/aspect analysis '
     'using Cesium.js or OpenLayers 3D extensions.'),
    ('Real-time collaborative editing',
     'WebSocket-based concurrent feature editing with conflict resolution, enabling multiple '
     'surveyors to work on the same project simultaneously.'),
    ('National land registry integration',
     'REST API connectors to DILRMP (Digital India Land Records Modernisation Programme) '
     'for cross-referencing defence parcels against state revenue records.'),
    ('Multi-language UI',
     'Localisation into Hindi and regional languages (Tamil, Telugu, Bengali, etc.) '
     'to support field staff across different states.'),
    ('PKI / smart-card authentication',
     'Integration with DGDE\'s internal PKI for mutual TLS client certificate login, '
     'replacing password-based authentication for high-security operations.'),
    ('Automated disaster-recovery backups',
     'Scheduled encrypted PostgreSQL dumps pushed to NIC Meghraj cloud object storage '
     'for off-site recovery without manual intervention.'),
    ('Regulatory report automation',
     'Pre-built report templates that automatically compile survey statistics, ownership summaries, '
     'and encroachment analysis into ministry-prescribed formats.'),
]:
    add_bullet(doc, label, detail, OLIVE)

# ── Footer rule ───────────────────────────────────────────────────────────────
doc.add_paragraph()
p = doc.add_paragraph()
pPr = p._p.get_or_add_pPr()
pBdr = OxmlElement('w:pBdr')
top_el = OxmlElement('w:top')
top_el.set(qn('w:val'), 'single')
top_el.set(qn('w:sz'), '6')
top_el.set(qn('w:space'), '1')
top_el.set(qn('w:color'), NAVY)
pBdr.append(top_el)
pPr.append(pBdr)

footer_p = doc.add_paragraph(
    f'RakshaGIS — Defence Estate GIS Survey Platform  |  '
    f'Prepared: {datetime.date.today().strftime("%d %B %Y")}  |  '
    'DGDE, Government of India  |  CONFIDENTIAL'
)
footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
footer_p.paragraph_format.space_before = Pt(4)
for run in footer_p.runs:
    run.font.size = Pt(8.5)
    run.font.color.rgb = rgb(MID_GRAY)

# ── Save ──────────────────────────────────────────────────────────────────────
out_path = 'RakshaGIS_Project_WriteUp.docx'
doc.save(out_path)
print(f'Saved: {out_path}')
