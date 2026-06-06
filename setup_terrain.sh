#!/usr/bin/env bash
# setup_terrain.sh — Download SRTM DEM tiles for India and convert to
# Cesium quantized-mesh format for the RakshaGIS terrain server.
#
# Requirements: Docker (for ctb-tile), wget or curl, ~10 GB disk space
#
# Usage:
#   ./setup_terrain.sh --download    Download SRTM 1 arc-second tiles for India
#   ./setup_terrain.sh --convert     Convert GeoTIFFs to quantized-mesh terrain tiles
#   ./setup_terrain.sh --all         Download + convert in one step
#   ./setup_terrain.sh --info        Show what's already downloaded

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve DATA_DIR in priority order:
#   1. Caller-exported env var  (build.sh passes DATA_DIR="$DATA_DIR")
#   2. DATA_DIR= line in .env   (standalone run after setup)
#   3. /RakshaGIS fallback
if [[ -z "${DATA_DIR:-}" ]]; then
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    DATA_DIR=$(grep "^DATA_DIR=" "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')
  fi
  DATA_DIR="${DATA_DIR:-/RakshaGIS}"
fi

TERRAIN_DIR="${DATA_DIR}/terrain"
SRTM_DIR="${TERRAIN_DIR}/srtm_raw"
OUTPUT_DIR="${TERRAIN_DIR}/tilesets/terrain"

# India SRTM 1 arc-second tile list (tiles covering ~68°E–98°E, 6°N–38°N)
# Tiles are named N{lat}E{lon} (1° × 1° each)
SRTM_BASE="https://srtm.csi.cgiar.org/wp-content/uploads/files/srtm_5x5/TIFF"

usage() {
  grep '^#' "$0" | grep -v '#!/' | sed 's/^# //' | sed 's/^#//'
  exit 0
}

info() {
  echo ""
  echo "==> Terrain data status:"
  echo "    SRTM raw:    ${SRTM_DIR}"
  echo "    Terrain out: ${OUTPUT_DIR}"
  local raw_count; raw_count=$(find "${SRTM_DIR}" -name "*.tif" 2>/dev/null | wc -l)
  local tile_count; tile_count=$(find "${OUTPUT_DIR}" -name "*.terrain" 2>/dev/null | wc -l)
  echo "    Raw GeoTIFFs downloaded : ${raw_count}"
  echo "    Terrain tiles generated : ${tile_count}"
  echo ""
}

download_srtm() {
  echo "==> Creating directories…"
  mkdir -p "${SRTM_DIR}"

  # CGIAR-CSI SRTM 5×5 degree tiles covering India
  # Tile naming: srtm_NN_NN.zip (5° tiles)
  # India falls in columns 42-50, rows 5-10 (approx)
  local tiles=(
    "srtm_42_05" "srtm_43_05" "srtm_44_05" "srtm_45_05"
    "srtm_42_06" "srtm_43_06" "srtm_44_06" "srtm_45_06" "srtm_46_06"
    "srtm_42_07" "srtm_43_07" "srtm_44_07" "srtm_45_07" "srtm_46_07"
    "srtm_42_08" "srtm_43_08" "srtm_44_08" "srtm_45_08" "srtm_46_08"
    "srtm_43_09" "srtm_44_09" "srtm_45_09" "srtm_46_09"
    "srtm_44_10" "srtm_45_10"
  )

  echo "==> Downloading ${#tiles[@]} SRTM 5×5 degree tiles (~250 MB each)…"
  echo "    Source: CGIAR-CSI SRTM v4.1"
  echo "    This may take 30–60 minutes depending on your connection."
  echo ""

  for tile in "${tiles[@]}"; do
    local out="${SRTM_DIR}/${tile}.tif"
    if [[ -f "${out}" ]]; then
      echo "    [skip] ${tile}.tif (already downloaded)"
      continue
    fi
    echo "    Downloading ${tile}…"
    wget -q --show-progress -O "${SRTM_DIR}/${tile}.zip" \
      "${SRTM_BASE}/${tile}.zip" || { echo "    [WARN] ${tile} not available, skipping"; continue; }
    unzip -q -o "${SRTM_DIR}/${tile}.zip" -d "${SRTM_DIR}/"
    mv "${SRTM_DIR}/${tile}.tif" "${out}" 2>/dev/null || true
    rm -f "${SRTM_DIR}/${tile}.zip"
    echo "    [ok] ${tile}.tif"
  done

  echo ""
  echo "==> Download complete."
  echo "    Run './setup_terrain.sh --convert' to generate terrain tiles."
}

convert_to_terrain() {
  local raw_count; raw_count=$(find "${SRTM_DIR}" -name "*.tif" 2>/dev/null | wc -l)
  if [[ "${raw_count}" -eq 0 ]]; then
    echo "ERROR: No .tif files found in ${SRTM_DIR}. Run --download first."
    exit 1
  fi

  echo "==> Merging ${raw_count} SRTM tiles into a single VRT…"
  mkdir -p "${OUTPUT_DIR}"
  local merged="${TERRAIN_DIR}/india_dem_merged.vrt"

  docker run --rm -v "${TERRAIN_DIR}:/data" ghcr.io/osgeo/gdal:ubuntu-small-latest \
    gdalbuildvrt /data/india_dem_merged.vrt /data/srtm_raw/*.tif

  echo "==> Converting VRT → quantized-mesh terrain tiles using ctb-tile…"
  echo "    This will take 1–3 hours for full India coverage at zoom 0–14."
  echo "    Output: ${OUTPUT_DIR}"
  echo ""

  docker run --rm \
    -v "${TERRAIN_DIR}:/data" \
    tumblr/ctb-tile:latest \
    ctb-tile \
      -f Mesh \
      -C \
      -o /data/tilesets/terrain \
      -z 0-14 \
      /data/india_dem_merged.vrt

  echo ""
  echo "==> Terrain tile generation complete."
  echo "    Tile count: $(find "${OUTPUT_DIR}" -name "*.terrain" | wc -l)"
  echo ""
  echo "==> Next steps:"
  echo "    Terrain tiles stored at : ${OUTPUT_DIR}"
  echo "    1. Start terrain server:  docker compose --profile terrain up -d terrain-server"
  echo "    2. Ensure .env has:       TERRAIN_TILE_URL=/terrain-tiles"
  echo "    3. Restart web:           docker compose restart web"
}

case "${1:-}" in
  --download) download_srtm ;;
  --convert)  convert_to_terrain ;;
  --all)      download_srtm; convert_to_terrain ;;
  --info)     info ;;
  *)          usage ;;
esac
