#!/bin/bash
set -e

echo "╔════════════════════════════════════════════════════════╗"
echo "║     Mapnik Installation - System Packages (Fixed)      ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Install system packages
echo ">>> Step 1: Installing system Mapnik packages..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    mapnik-utils \
    python3-mapnik \
    libmapnik-dev

echo "✓ System packages installed"
echo ""

# Step 2: Create directories
echo ">>> Step 2: Creating service directories..."
mkdir -p services/mapnik/styles
mkdir -p services/mapnik/data
mkdir -p services/mapnik/cache
chmod 755 services/mapnik

echo "✓ Directories created"
echo ""

# Step 3: Verify installation
echo ">>> Step 3: Verifying Mapnik installation..."
python3 << 'PYEOF'
try:
    import mapnik
    version = mapnik.mapnik_version()
    print(f"✓ Mapnik {version} installed successfully!")
    print(f"  Python binding: OK")
except Exception as e:
    print(f"✗ Error: {e}")
    exit(1)
PYEOF

echo ""

# Step 4: Create sample style
echo ">>> Step 4: Creating sample boundaries.xml..."
if [ ! -f "services/mapnik/styles/boundaries.xml" ]; then
    cat > services/mapnik/styles/boundaries.xml << 'XMLEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Map>
<Map srs="+proj=merc +a=6378137 +b=6378137 +over" background-color="#b3d9ff">

  <Parameters>
    <Parameter name="name">RakshaGIS Boundaries</Parameter>
    <Parameter name="description">Survey and administrative boundaries</Parameter>
  </Parameters>

  <!-- Layer: State Boundaries -->
  <Layer name="state_boundaries" srs="+proj:longlat +ellps=WGS84 +datum=WGS84 +no_defs">
    <StyleName>state_style</StyleName>
    <Datasource>
      <Parameter name="type">postgis</Parameter>
      <Parameter name="dbname">rakshagis</Parameter>
      <Parameter name="host">localhost</Parameter>
      <Parameter name="port">5432</Parameter>
      <Parameter name="user">raksha</Parameter>
      <Parameter name="password">YOUR_PASSWORD_HERE</Parameter>
      <Parameter name="table">
        (SELECT id, name, geometry FROM gis_layers_boundary
         WHERE boundary_type = 'STATE' AND geometry IS NOT NULL) AS state_boundaries
      </Parameter>
      <Parameter name="geometry_field">geometry</Parameter>
      <Parameter name="use_spatial_index">true</Parameter>
    </Datasource>
  </Layer>

  <!-- Styles -->
  <Style name="state_style">
    <Rule>
      <MaxScaleDenominator>250000</MaxScaleDenominator>
      <LineSymbolizer stroke="#333333" stroke-width="2" stroke-opacity="0.9"/>
    </Rule>
  </Style>

</Map>
XMLEOF
    echo "✓ Sample boundaries.xml created"
else
    echo "✓ boundaries.xml already exists"
fi

echo ""

# Step 5: Summary
echo "╔════════════════════════════════════════════════════════╗"
echo "║          Installation Complete ✓                       ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "✓ Mapnik system packages installed"
echo "✓ Python Mapnik binding ready"
echo "✓ Service directories created"
echo "✓ Sample style file created"
echo ""
echo "NEXT STEPS:"
echo "1. Update database credentials:"
echo "   nano services/mapnik/styles/boundaries.xml"
echo "   Change: user, password, dbname, host"
echo ""
echo "2. Test rendering:"
echo "   python3 << 'EOF'"
echo "   import mapnik"
echo "   m = mapnik.Map(800, 600)"
echo "   mapnik.load_map(m, 'services/mapnik/styles/boundaries.xml')"
echo "   m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))"
echo "   img = mapnik.Image(800, 600)"
echo "   mapnik.render(m, img)"
echo "   img.save('test.png')"
echo "   print('✓ Success!')"
echo "   EOF"
echo ""
echo "3. See HOW_TO_USE_MAPNIK.md for complete usage guide"
echo ""
