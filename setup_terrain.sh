#!/usr/bin/env bash
# setup_terrain.sh — Download SRTM DEM tiles for India and convert to
# Cesium quantized-mesh format for the RakshaGIS local terrain server.
#
# Requirements: Docker, wget, ~5 GB disk space in DATA_DIR
#
# Usage:
#   ./setup_terrain.sh --download    Download SRTM 90m tiles for India (~2 GB)
#   ./setup_terrain.sh --convert     Convert GeoTIFFs → quantized-mesh terrain tiles
#   ./setup_terrain.sh --start       Start the terrain-server Docker profile
#   ./setup_terrain.sh --all         Download + convert + start in one step
#   ./setup_terrain.sh --info        Show what's already downloaded / generated
#
# After --all completes, edit .env:
#   TERRAIN_TILE_URL=/terrain-tiles
#   (comment out or remove CESIUM_ION_TOKEN to force offline mode)
#
# Offline-first behaviour (when both are set):
#   - Local terrain is preferred; Ion is used only as a fallback when the
#     terrain-server is not reachable (e.g. before --start is run).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Resolve DATA_DIR ─────────────────────────────────────────────────────────
if [[ -z "${DATA_DIR:-}" ]]; then
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    DATA_DIR=$(grep "^DATA_DIR=" "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  fi
fi
if [[ -z "${DATA_DIR:-}" ]]; then
  echo "ERROR: DATA_DIR is not set."
  echo "  Set it in .env:  DATA_DIR=/your/data/path"
  echo "  Or export it:    DATA_DIR=/your/data/path ./setup_terrain.sh --download"
  exit 1
fi
DATA_DIR="$(cd "$DATA_DIR" 2>/dev/null && pwd || echo "$DATA_DIR")"

TERRAIN_DIR="${DATA_DIR}/terrain"
SRTM_DIR="${TERRAIN_DIR}/srtm_raw"
# Tiles go directly into TERRAIN_DIR — nginx mounts this as the web root, so
# layer.json is at /terrain-tiles/layer.json and tiles at /terrain-tiles/{z}/{x}/{y}.terrain.
OUTPUT_DIR="${TERRAIN_DIR}"

# ── CGIAR-CSI SRTM v4.1  (90 m / 3 arc-second, no registration required) ───
# Tile grid: cols 01-72 (5° wide), rows 01-24 (5° tall)
#   col = floor((lon + 180) / 5) + 1
#   row = floor((60  - lat) / 5) + 1
#
# India bounding box: 65-100°E, 5-40°N  → cols 50-56, rows 5-11
#   col 50 → 65-70°E    col 51 → 70-75°E    col 52 → 75-80°E
#   col 53 → 80-85°E    col 54 → 85-90°E    col 55 → 90-95°E    col 56 → 95-100°E
#   row  5 → 35-40°N    row  6 → 30-35°N    row  7 → 25-30°N    row  8 → 20-25°N
#   row  9 → 15-20°N    row 10 → 10-15°N    row 11 →  5-10°N
SRTM_BASE="https://srtm.csi.cgiar.org/wp-content/uploads/files/srtm_5x5/TIFF"

CGIAR_TILES=(
  # Row 5 — Himalayas / J&K / northeast India (35-40°N)
  "srtm_50_05" "srtm_51_05" "srtm_52_05" "srtm_53_05" "srtm_54_05" "srtm_55_05" "srtm_56_05"
  # Row 6 — Rajasthan / Uttarakhand / Assam (30-35°N)
  "srtm_50_06" "srtm_51_06" "srtm_52_06" "srtm_53_06" "srtm_54_06" "srtm_55_06" "srtm_56_06"
  # Row 7 — Gujarat / MP / WB / Meghalaya (25-30°N)
  "srtm_50_07" "srtm_51_07" "srtm_52_07" "srtm_53_07" "srtm_54_07" "srtm_55_07" "srtm_56_07"
  # Row 8 — Maharashtra / Chhattisgarh / Jharkhand (20-25°N)
  "srtm_50_08" "srtm_51_08" "srtm_52_08" "srtm_53_08" "srtm_54_08" "srtm_55_08" "srtm_56_08"
  # Row 9 — Goa / Andhra / Odisha (15-20°N)
  "srtm_50_09" "srtm_51_09" "srtm_52_09" "srtm_53_09" "srtm_54_09" "srtm_55_09" "srtm_56_09"
  # Row 10 — Karnataka / Tamil Nadu north / A&N (10-15°N)
  "srtm_50_10" "srtm_51_10" "srtm_52_10" "srtm_53_10" "srtm_54_10" "srtm_55_10" "srtm_56_10"
  # Row 11 — Kerala / Tamil Nadu south / Lakshadweep (5-10°N)
  "srtm_50_11" "srtm_51_11" "srtm_52_11" "srtm_53_11" "srtm_54_11" "srtm_55_11" "srtm_56_11"
)

# ─────────────────────────────────────────────────────────────────────────────

usage() {
  grep '^#' "$0" | grep -v '#!/' | sed 's/^# //' | sed 's/^#//'
  exit 0
}

info() {
  echo ""
  echo "==> Terrain data status"
  echo "    DATA_DIR:    ${DATA_DIR}"
  echo "    SRTM raw:    ${SRTM_DIR}"
  echo "    Tile output: ${OUTPUT_DIR}"
  local raw_count tile_count layer_ok
  raw_count=$(find "${SRTM_DIR}" -name "*.tif" 2>/dev/null | wc -l)
  tile_count=$(find "${OUTPUT_DIR}" -name "*.terrain" 2>/dev/null | wc -l)
  layer_ok="MISSING"
  [[ -f "${OUTPUT_DIR}/layer.json" ]] && layer_ok="OK"
  echo "    SRTM tiles downloaded : ${raw_count} / ${#CGIAR_TILES[@]}"
  echo "    Quantized-mesh tiles  : ${tile_count}"
  echo "    layer.json            : ${layer_ok}"
  if [[ "${tile_count}" -gt 0 && "${layer_ok}" == "OK" ]]; then
    echo ""
    echo "    Terrain server is ready. Start it with:"
    echo "      docker compose --profile terrain up -d terrain-server"
    echo "    Then ensure .env has: TERRAIN_TILE_URL=/terrain-tiles"
  fi
  echo ""
}

# ── Step 1: download raw SRTM GeoTIFFs ───────────────────────────────────────
download_srtm() {
  echo "==> Creating directories…"
  mkdir -p "${SRTM_DIR}"

  local total=${#CGIAR_TILES[@]}
  echo "==> Downloading ${total} SRTM 5×5° tiles covering India (~1-2 GB total)"
  echo "    Source: CGIAR-CSI SRTM v4.1 (90 m / 3 arc-second)"
  echo "    Coverage: 65-100°E, 5-40°N  (all of India + borders)"
  echo "    This may take 20-60 minutes depending on your connection."
  echo ""

  local n=0 ok=0 skip=0 fail=0
  for tile in "${CGIAR_TILES[@]}"; do
    n=$((n + 1))
    local out="${SRTM_DIR}/${tile}.tif"
    if [[ -f "${out}" ]]; then
      echo "    [${n}/${total}] skip  ${tile}.tif (already downloaded)"
      skip=$((skip + 1))
      continue
    fi
    echo "    [${n}/${total}] fetch ${tile}.zip …"
    if wget -q --show-progress --timeout=60 --tries=3 \
        -O "${SRTM_DIR}/${tile}.zip" "${SRTM_BASE}/${tile}.zip" 2>&1; then
      unzip -q -o "${SRTM_DIR}/${tile}.zip" -d "${SRTM_DIR}/"
      # The zip may contain a .tif with the same name or just 'output.tif'
      if [[ ! -f "${out}" ]]; then
        local any_tif
        any_tif=$(find "${SRTM_DIR}" -maxdepth 1 -name "${tile%.tif}*.tif" \
                  ! -path "${out}" 2>/dev/null | head -1)
        [[ -n "${any_tif}" ]] && mv "${any_tif}" "${out}"
      fi
      rm -f "${SRTM_DIR}/${tile}.zip"
      [[ -f "${out}" ]] && { echo "          → ok"; ok=$((ok + 1)); } \
                        || { echo "          → WARN: .tif not found after unzip"; fail=$((fail + 1)); }
    else
      echo "          → WARN: download failed (tile may not exist), skipping"
      rm -f "${SRTM_DIR}/${tile}.zip"
      fail=$((fail + 1))
    fi
  done

  echo ""
  echo "==> Download complete: ${ok} new, ${skip} skipped, ${fail} failed."
  local tif_count; tif_count=$(find "${SRTM_DIR}" -name "*.tif" | wc -l)
  echo "    Total .tif files in ${SRTM_DIR}: ${tif_count}"
  if [[ "${tif_count}" -eq 0 ]]; then
    echo ""
    echo "    ERROR: No tiles downloaded."
    echo "    The CGIAR server may be temporarily unavailable."
    echo "    Alternatives:"
    echo "      • USGS EarthExplorer (free account): https://earthexplorer.usgs.gov/"
    echo "        Product: SRTM 1 Arc-Second Global (30 m) or SRTM Void Filled"
    echo "        Download SRTM1 HGT files and convert to GeoTIFF:"
    echo "          gdal_translate N20E078.hgt srtm_N20E078.tif"
    echo "        Place all .tif files in: ${SRTM_DIR}"
    echo "      • OpenTopography (free account): https://opentopography.org/"
    exit 1
  fi
  echo ""
  echo "    Run './setup_terrain.sh --convert' to generate terrain tiles (~1-3 h)"
}

# ── Step 2: convert to Cesium quantized-mesh tiles ───────────────────────────
convert_to_terrain() {
  local raw_count; raw_count=$(find "${SRTM_DIR}" -name "*.tif" 2>/dev/null | wc -l)
  if [[ "${raw_count}" -eq 0 ]]; then
    echo "ERROR: No .tif files in ${SRTM_DIR}. Run --download first."
    echo "       Or place SRTM GeoTIFFs manually in that directory."
    exit 1
  fi

  # Skip if tiles already exist — layer.json + at least one .terrain file in zoom dir
  local existing_tiles; existing_tiles=$(find "${OUTPUT_DIR}" -name "*.terrain" 2>/dev/null | wc -l)
  if [[ "${existing_tiles}" -gt 0 && -f "${OUTPUT_DIR}/layer.json" ]]; then
    echo "==> Terrain tiles already exist (${existing_tiles} .terrain files + layer.json found)."
    echo "    Skipping conversion. Delete ${OUTPUT_DIR}/layer.json to force re-convert."
    return 0
  fi

  echo "==> Found ${raw_count} SRTM tiles in ${SRTM_DIR}"
  mkdir -p "${OUTPUT_DIR}"

  # ── Merge tiles into a single VRT (just an XML descriptor — no disk overflow) ─
  echo "==> Merging tiles into a single VRT…"
  local merged="${TERRAIN_DIR}/india_dem_merged.vrt"
  local lowres="${TERRAIN_DIR}/india_dem_lowres.tif"

  # Use local GDAL if available; fall back to Docker GDAL.
  # When running in Docker, translate all TERRAIN_DIR host paths to /data
  # (the container mount point) so the GDAL command sees valid paths.
  _gdal_run() {
    if command -v "$1" &>/dev/null; then
      "$@"
    else
      local cmd="$1"; shift
      local -a docker_args=()
      for arg in "$@"; do
        # Replace TERRAIN_DIR prefix with /data (the bind-mount target)
        docker_args+=("${arg/${TERRAIN_DIR}//data}")
      done
      docker run --rm \
        -v "${TERRAIN_DIR}:/data" \
        ghcr.io/osgeo/gdal:ubuntu-small-latest \
        "${cmd}" "${docker_args[@]}"
    fi
  }

  _gdal_run gdalbuildvrt "${merged}" "${SRTM_DIR}"/*.tif
  echo "    VRT built: $(basename "${merged}")"

  # ── Low-res raster for zoom 0-7 ───────────────────────────────────────────
  # Downsampling to 5% avoids a 32-bit pixel-count overflow inside older GDAL
  # builds used in the ctb-tile Docker image (full India VRT ≈ 36 000 × 30 000 px).
  echo "==> Building low-res DEM for zoom 0-7 (5% resample)…"
  _gdal_run gdal_translate \
    -outsize 5% 5% -of GTiff \
    -co COMPRESS=LZW -co TILED=YES \
    "${merged}" "${lowres}"
  echo "    Low-res DEM: $(basename "${lowres}")"

  # ── ctb-tile ─────────────────────────────────────────────────────────────
  # -f Mesh     → Quantized Mesh format (required by CesiumTerrainProvider)
  # -C          → Cesium-compatible output (correct tile scheme + layer.json)
  # -N          → vertex normals (enables requestVertexNormals in Cesium)
  # -o /data    → output directly into TERRAIN_DIR (= nginx web root)
  #               so layer.json is at /terrain-tiles/layer.json
  #               and tiles at /terrain-tiles/{z}/{x}/{y}.terrain
  #
  # NOTE: ctb-tile cannot take the full merged VRT at full resolution without
  # overflowing; that's why zoom 0-7 uses the low-res version and zoom 8-14
  # processes individual 5°×5° tiles one at a time.

  echo ""
  echo "==> Pass 1/2 — zoom levels 0-7 from low-res DEM (~5 min)…"
  docker run --rm \
    -v "${TERRAIN_DIR}:/data" \
    tumgis/ctb-quantized-mesh \
    ctb-tile -f Mesh -C -N \
      -o /data \
      -z 0-7 \
      /data/india_dem_lowres.tif

  echo ""
  echo "==> Pass 2/2 — zoom levels 8-14 from individual tiles (~1-3 h for ${raw_count} tiles)…"
  local n=0
  for tif_path in "${SRTM_DIR}"/*.tif; do
    [[ -f "${tif_path}" ]] || continue
    local tif_name; tif_name=$(basename "${tif_path}")
    n=$((n + 1))
    echo "    [${n}/${raw_count}] ${tif_name}…"
    docker run --rm \
      -v "${TERRAIN_DIR}:/data" \
      tumgis/ctb-quantized-mesh \
      ctb-tile -f Mesh -C -N \
        -o /data \
        -z 8-14 \
        "/data/srtm_raw/${tif_name}"
  done

  local tile_count; tile_count=$(find "${OUTPUT_DIR}" -name "*.terrain" 2>/dev/null | wc -l)
  echo ""
  echo "==> Done! Generated ${tile_count} quantized-mesh tiles."

  # Always (re)generate layer.json with the "available" tile index by scanning
  # the tiles on disk. Cesium fails without it:
  #   "TypeError: can't access property computeChildMaskForTile,
  #    e.availability is undefined"
  echo "    Generating layer.json with availability index…"
  python3 "${SCRIPT_DIR}/scripts/generate_terrain_layer.py" "${OUTPUT_DIR}"
  echo "    layer.json : ${OUTPUT_DIR}/layer.json  ✓"
  echo ""
  echo "==> Next steps:"
  echo "    1. Start terrain server:  docker compose --profile terrain up -d terrain-server"
  echo "    2. Ensure .env has:       TERRAIN_TILE_URL=/terrain-tiles"
  echo "    3. Restart web:           docker compose restart web nginx"
  echo ""
  echo "    Offline-first: when TERRAIN_TILE_URL is set in .env, local terrain"
  echo "    takes priority over Cesium Ion — analysis works without internet."
}

# ── Step 3: start the terrain-server profile ─────────────────────────────────
start_server() {
  echo "==> Starting terrain-server Docker profile…"
  cd "${SCRIPT_DIR}"
  # Read port from .env (DATA_DIR-aware) rather than relying on a possibly-unset env var
  local _http_port
  _http_port=$(grep "^RAKSHAGIS_HTTP_PORT=" "${SCRIPT_DIR}/.env" 2>/dev/null \
               | cut -d= -f2 | tr -d '\r' || echo "80")
  _http_port="${_http_port:-80}"
  docker compose --profile terrain up -d terrain-server
  echo ""
  echo "==> Terrain server started."
  echo "    Tile root : ${DATA_DIR}/terrain/"
  echo "    Verify   : curl -s http://localhost:${_http_port}/terrain-tiles/layer.json"
  echo "    Restart web if needed: docker compose restart web nginx"
}

# ─────────────────────────────────────────────────────────────────────────────

case "${1:-}" in
  --download) download_srtm ;;
  --convert)  convert_to_terrain ;;
  --start)    start_server ;;
  --all)      download_srtm; convert_to_terrain; start_server ;;
  --info)     info ;;
  *)          usage ;;
esac
