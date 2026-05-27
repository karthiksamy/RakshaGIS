#!/usr/bin/env bash
# build_plugin.sh — Package the RakshaGIS Sync QGIS plugin
#
# Usage:
#   ./build_plugin.sh                  # creates rakshagis_sync.zip in this directory
#   ./build_plugin.sh --install        # also copies to QGIS plugins folder (Linux/Mac)
#   ./build_plugin.sh --version 1.2.0  # override version tag in output filename
#
# Output: rakshagis_sync_<version>.zip  (or rakshagis_sync.zip if no metadata)
#
# QGIS plugin install paths (auto-detected):
#   Linux:  ~/.local/share/QGIS/QGIS3/profiles/default/python/plugins/
#   macOS:  ~/Library/Application Support/QGIS/QGIS3/profiles/default/python/plugins/
#   Windows: %APPDATA%\QGIS\QGIS3\profiles\default\python\plugins\

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="rakshagis_sync"
PLUGIN_DIR="${SCRIPT_DIR}/${PLUGIN_NAME}"
BUILD_DIR="${SCRIPT_DIR}/_build"
INSTALL=false
VERSION=""

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --install) INSTALL=true; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Read version from metadata.txt if not overridden ─────────────────────────
if [[ -z "$VERSION" ]] && [[ -f "${PLUGIN_DIR}/metadata.txt" ]]; then
  VERSION=$(grep -E '^version=' "${PLUGIN_DIR}/metadata.txt" | cut -d= -f2 | tr -d '[:space:]')
fi
VERSION="${VERSION:-1.0.0}"

ZIP_NAME="${PLUGIN_NAME}_${VERSION}.zip"
ZIP_PATH="${SCRIPT_DIR}/${ZIP_NAME}"

echo "Building ${ZIP_NAME}..."

# ── Clean up previous build ───────────────────────────────────────────────────
rm -rf "${BUILD_DIR}"
rm -f "${SCRIPT_DIR}/${PLUGIN_NAME}_*.zip" 2>/dev/null || true
mkdir -p "${BUILD_DIR}/${PLUGIN_NAME}"

# ── Copy plugin sources (excluding dev artifacts) ─────────────────────────────
rsync -a --exclude='__pycache__' \
         --exclude='*.pyc' \
         --exclude='*.pyo' \
         --exclude='.git' \
         --exclude='*.egg-info' \
         --exclude='tests/' \
         --exclude='.pytest_cache' \
         "${PLUGIN_DIR}/" "${BUILD_DIR}/${PLUGIN_NAME}/"

# ── Create ZIP ────────────────────────────────────────────────────────────────
(cd "${BUILD_DIR}" && zip -r "${ZIP_PATH}" "${PLUGIN_NAME}" -x '*.DS_Store')

echo "Created: ${ZIP_PATH}"

# ── Install into QGIS if requested ───────────────────────────────────────────
if [[ "$INSTALL" == "true" ]]; then
  case "$(uname -s)" in
    Linux*)
      QGIS_PLUGINS="${HOME}/.local/share/QGIS/QGIS3/profiles/default/python/plugins"
      ;;
    Darwin*)
      QGIS_PLUGINS="${HOME}/Library/Application Support/QGIS/QGIS3/profiles/default/python/plugins"
      ;;
    MINGW*|CYGWIN*|MSYS*)
      QGIS_PLUGINS="${APPDATA}/QGIS/QGIS3/profiles/default/python/plugins"
      ;;
    *)
      echo "Auto-install not supported on this OS. Install ${ZIP_NAME} manually."
      INSTALL=false
      ;;
  esac

  if [[ "$INSTALL" == "true" ]]; then
    DEST="${QGIS_PLUGINS}/${PLUGIN_NAME}"
    echo "Installing to: ${DEST}"
    mkdir -p "${QGIS_PLUGINS}"
    rm -rf "${DEST}"
    cp -r "${BUILD_DIR}/${PLUGIN_NAME}" "${DEST}"
    echo "Installed! Restart QGIS and enable 'RakshaGIS Sync' in Plugins → Manage and Install Plugins."
  fi
fi

# ── Cleanup temp build dir ────────────────────────────────────────────────────
rm -rf "${BUILD_DIR}"
echo "Done."
