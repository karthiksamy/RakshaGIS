#!/bin/bash
# Quick installation script for Mapnik in RakshaGIS
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo $SCRIPT_DIR
echo "╔════════════════════════════════════════════════════════╗"
echo "║            Mapnik Installation for RakshaGIS           ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Install system packages
echo ">>> Step 1: Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
    mapnik-utils \
    python3-mapnik \
    libmapnik-dev \
    libmapnik3.1

echo "✓ System packages installed"
echo ""

# Step 2: Create Mapnik service directories
echo ">>> Step 2: Creating service directories..."
mkdir -p "$SCRIPT_DIR/services/mapnik/styles"
mkdir -p "$SCRIPT_DIR/services/mapnik/data"
mkdir -p "$SCRIPT_DIR/services/mapnik/cache"
chmod 755 "$SCRIPT_DIR/services/mapnik"

echo "✓ Directories created at $SCRIPT_DIR/services/mapnik"
echo ""

# Step 3: Install Python Mapnik
echo ">>> Step 3: Installing Python Mapnik..."
source "$SCRIPT_DIR/venv/bin/activate" 2>/dev/null || {
    echo "⚠ Virtual environment not found. Creating one..."
    python3 -m venv "$SCRIPT_DIR/venv"
    source "$SCRIPT_DIR/venv/bin/activate"
}

pip install -q mapnik

echo "✓ Python Mapnik installed"
echo ""

# Step 4: Test Mapnik
echo ">>> Step 4: Testing Mapnik installation..."
python3 << 'PYEOF'
try:
    import mapnik
    m = mapnik.Map(800, 600)
    version = mapnik.mapnik_version()
    print(f"✓ Mapnik version {version} ready!")
    print(f"  Python binding: OK")
except Exception as e:
    print(f"✗ Error: {e}")
    exit(1)
PYEOF

echo ""

# Step 5: Create sample style file
echo ">>> Step 5: Creating sample boundaries.xml..."
cat > "$SCRIPT_DIR/services/mapnik/styles/boundaries.xml" << 'XMLEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Map>
<Map srs="+proj=merc +a=6378137 +b=6378137" background-color="#b3d9ff">

  <!-- Placeholder: Add actual layers from your PostGIS database -->
  <!-- Example layer structure included in MAPNIK_INTEGRATION.md -->

</Map>
XMLEOF

echo "✓ Sample boundaries.xml created"
echo ""

# Step 6: Summary
echo "╔════════════════════════════════════════════════════════╗"
echo "║          Installation Complete ✓                       ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "1. Update boundaries.xml with your PostGIS datasources"
echo "   File: $SCRIPT_DIR/services/mapnik/styles/boundaries.xml"
echo ""
echo "2. Add Django views from MAPNIK_INTEGRATION.md"
echo "   Apps: apps/core/views.py"
echo ""
echo "3. Add React export component"
echo "   Component: frontend/src/features/map/MapExportModal.tsx"
echo ""
echo "4. Test rendering:"
echo "   python3 << 'EOF'"
echo "   import mapnik"
echo "   m = mapnik.Map(800, 600)"
echo "   mapnik.load_map(m, '$SCRIPT_DIR/services/mapnik/styles/boundaries.xml')"
echo "   m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))"
echo "   img = mapnik.Image(800, 600)"
echo "   mapnik.render(m, img)"
echo "   img.save('test_map.png')"
echo "   EOF"
echo ""
echo "5. See MAPNIK_INTEGRATION.md for detailed setup guide"
echo ""
