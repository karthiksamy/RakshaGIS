# RakshaGIS Sync — QGIS Plugin

Automatically uploads QGIS processing outputs (Change Detection, Land Use Analysis,
Classification, etc.) to the RakshaGIS server with smart folder routing and background sync.

## Installation

### Option A — Build and install script (Recommended)
```bash
cd qgis_plugin/
./build_plugin.sh --install   # builds ZIP and copies to QGIS plugins folder
```
Restart QGIS, then enable the plugin via **Plugins → Manage Plugins → RakshaGIS Sync**.

### Option B — Install from ZIP
```bash
cd qgis_plugin/
./build_plugin.sh             # creates rakshagis_sync_1.0.0.zip
```
In QGIS: **Plugins → Manage and Install Plugins → Install from ZIP** → select the ZIP.

### Option C — Copy folder directly
Copy the `rakshagis_sync/` folder to:
- **Windows**: `%APPDATA%\QGIS\QGIS3\profiles\default\python\plugins\`
- **Linux**:   `~/.local/share/QGIS/QGIS3/profiles/default/python/plugins/`
- **macOS**:   `~/Library/Application Support/QGIS/QGIS3/profiles/default/python/plugins/`

---

## First-time Setup

1. Click **⚙ Settings** in the RakshaGIS Sync toolbar.
2. **Connection** tab — enter Server URL and a service-account username/password.
   (The account must have SDO or SURVEYOR role and no 2FA.)
3. Click **Test Connection** — the project dropdown populates.
4. **Sync Options** tab — select a Default Project and tick auto-upload options.
5. **Algorithm Mapping** tab — add custom algorithm ID → module name rules if needed.
6. Click **OK**.

---

## Usage

### Manual Upload (drag & drop)
1. Click **⬆ Upload** in the toolbar.
2. Drag files into the list, or click **Add Files…**
3. Enter a **Module / Folder** name (e.g. `Change Detection`).
4. Click **Upload** — files are queued for background upload.

### Layer Panel (right-click)
Right-click any vector or raster layer → **Upload to RakshaGIS…**  
Opens the upload dialog with the layer's source file pre-loaded.

### Auto-upload from Processing (Phase 2)
Enable **Auto-upload when Processing algorithm finishes** in Settings.  
Every time a Processing algorithm completes, its output files are automatically
queued for upload. The algorithm name maps to the module folder via the
**Algorithm Mapping** tab (user-configurable) or built-in defaults.

Built-in algorithm → module mappings:

| Algorithm ID contains | Module folder |
|-----------------------|---------------|
| `change`              | Change Detection |
| `classification`      | Land Use Classification |
| `landuse` / `land_use`| Land Use Analysis |
| `raster`              | Raster Processing |
| `gdal`                | GDAL Processing |

### Watched Directories (Phase 3 — Background Sync)
In **Settings → Sync Options**, add one or more **Watched Directories**.  
Any supported file written to those directories is automatically detected and uploaded.  
The watch persists between QGIS sessions (saved in QgsSettings).

### Processing Toolbox
Three algorithms are available under **Processing Toolbox → RakshaGIS Sync**:
- **Upload Layer to RakshaGIS** — upload a single map layer's source file
- **Upload Directory to RakshaGIS** — batch-upload all supported files in a folder
- **Watch Directory (Auto-sync)** — register a folder for background file watching

---

## Folder Structure Created in RakshaGIS

Every module (Change Detection, Land Use Analysis, etc.) always gets the same
three sub-folders, created automatically on first upload:

```
Project: AFS Sulur
├── Change Detection/          ← module folder (PHASE type)
│   ├── Shapefile/             ← .zip shapefiles, .geojson, .kml, .gpkg
│   ├── Raster/                ← .tif / .tiff GeoTIFF outputs
│   └── Doc/                   ← .csv, .pdf, .xlsx, images, reports
├── Land Use Analysis/
│   ├── Shapefile/
│   ├── Raster/
│   └── Doc/
└── Classification/
    ├── Shapefile/
    ├── Raster/
    └── Doc/
```

---

## Supported File Types

| Extension            | Sub-folder   | Upload route         |
|----------------------|--------------|----------------------|
| `.tif` / `.tiff`     | `Raster/`    | GIS file (GeoTIFF)   |
| `.zip`               | `Shapefile/` | GIS file (shapefile) |
| `.geojson` / `.json` | `Shapefile/` | GIS file (vector)    |
| `.gpkg`              | `Shapefile/` | GIS file (vector)    |
| `.kml`               | `Shapefile/` | GIS file (vector)    |
| `.csv`               | `Doc/`       | Document             |
| `.pdf`               | `Doc/`       | Document             |
| `.xlsx` / `.xls`     | `Doc/`       | Document             |
| `.png` / `.jpg`      | `Doc/`       | Document             |
| `.docx` / `.doc`     | `Doc/`       | Document             |

---

## Algorithm Mapping (user-configurable)

Open **Settings → Algorithm Mapping** to add or override the algorithm ID → module name mapping:

| Algorithm ID (or prefix)    | Module Name on Server     |
|-----------------------------|---------------------------|
| `qgis:changedetection`      | Change Detection          |
| `myplugin:landuse_classify` | Land Use Classification   |

Exact match is checked first, then substring match. Built-in defaults always apply as fallback.

---

## Python Console API

```python
from qgis.utils import plugins
sync = plugins['rakshagis_sync']

# Upload a single file
sync.upload_file('/output/change_detection.tif',
                 project_id=3,
                 module_name='Change Detection')
# → creates project 3 / Change Detection / Raster/

# Upload an entire directory
count = sync.upload_directory('/output/land_use/', project_id=3,
                               module_name='Land Use Analysis')
print(f'Queued {count} files')
```

---

## Upload History

Click **📋 History** in the toolbar to see upload status in real time.  
Server-side logs are available at:

```
GET /api/projects/qgis-uploads/?project={id}
GET /api/projects/qgis-uploads/?status=FAILED
```

Admins can view all uploads across projects in the RakshaGIS web app under
**Admin → QGIS Sync**. Failed uploads can be flagged for retry from the web UI,
which notifies the original uploader to re-run the upload from QGIS.

---

## Requirements
- QGIS 3.16 or newer
- RakshaGIS server v2.0+ (Phase 5+)
- No additional Python packages required (uses stdlib `urllib` only)
