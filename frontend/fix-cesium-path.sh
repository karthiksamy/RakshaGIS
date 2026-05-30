#!/bin/bash
# Fix Cesium asset paths after vite-plugin-cesium builds
# vite-plugin-cesium nests Cesium assets in a 'static/' subdirectory
# This script moves them to the root of the build output

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/../staticfiles"

if [ ! -d "$BUILD_DIR/static/cesium" ]; then
  echo "⚠ No Cesium assets found in $BUILD_DIR/static/cesium/"
  echo "  (This might be normal if Cesium wasn't included in this build)"
  exit 0
fi

echo "Fixing Cesium asset paths..."
echo "  Moving $BUILD_DIR/static/cesium → $BUILD_DIR/cesium"

# Move Cesium to the root of staticfiles
mv "$BUILD_DIR/static/cesium" "$BUILD_DIR/cesium"

# Remove empty static directory if it's now empty
if [ -d "$BUILD_DIR/static" ] && [ -z "$(ls -A $BUILD_DIR/static 2>/dev/null)" ]; then
  rmdir "$BUILD_DIR/static" 2>/dev/null || true
fi

echo "✓ Cesium paths fixed"
echo "  Cesium.js should now be at: /static/cesium/Cesium.js"
