# Map Printing Tools Comparison for RakshaGIS

## Current Implementation
- **jsPDF** + **html2canvas** - Client-side screenshot capture to PDF
- **Pros**: No server resources, works offline
- **Cons**: Limited resolution, CSS compatibility issues, can't capture WebGL

---

## 1. 🔥 **Puppeteer / Playwright** (Recommended for Production)

**Server-side headless browser automation**

### Pros:
- ✅ Capture exact map state at high resolution
- ✅ Supports all map features (WebGL, layers, zoom)
- ✅ Full CSS/JavaScript support
- ✅ PDF/PNG/SVG export
- ✅ Batch processing support
- ✅ Can print complex layouts with text overlays

### Cons:
- ❌ Requires server resources
- ❌ Slower than client-side (5-15 seconds per map)

### Implementation:
```javascript
// Backend example (Node.js)
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3000/map?export=true');
await page.pdf({ path: 'map.pdf', format: 'A4' });
```

### Best For:
- High-quality professional maps
- Complex layouts with legends/annotations
- High-resolution printing (300+ DPI)
- Reports with multiple maps

---

## 2. 📍 **Maplibre GL Export**

**WebGL-based map rendering with export**

### Pros:
- ✅ Modern, fast WebGL maps
- ✅ Native export to PNG/SVG
- ✅ High resolution support
- ✅ Works with vector tiles

### Cons:
- ❌ Requires Maplibre GL (different from current OpenLayers)
- ❌ Limited layout options

### Example:
```typescript
const canvas = map.getCanvas();
const image = canvas.toDataURL('image/png');
// Convert to PDF
```

---

## 3. 🗺️ **Mapnik + CartoCSS** (GIS Professional Standard)

**Server-side raster map rendering**

### Pros:
- ✅ Industry standard for map publishing
- ✅ Extremely fast (50+ maps/second)
- ✅ Perfect styling control
- ✅ 300+ DPI support
- ✅ Used by OpenStreetMap

### Cons:
- ❌ Complex setup (C++ based)
- ❌ Steep learning curve
- ❌ Requires separate style definition

### Implementation:
```bash
# Installation
apt-get install mapnik

# Usage - Node.js with node-mapnik
const mapnik = require('mapnik');
const map = new mapnik.Map(800, 600);
map.load('style.xml');
map.render((err, image) => { /* save image */ });
```

### Best For:
- High-volume map generation
- Publication-quality cartography
- Customized map styling
- Large-scale deployments

---

## 4. 🎨 **ReportLab (Python)**

**PDF generation with map overlays**

### Pros:
- ✅ Pure Python, easy integration with Django
- ✅ Create complex PDFs with maps
- ✅ No external dependencies
- ✅ Great for reports

### Cons:
- ❌ Static maps only (no interactivity)
- ❌ Requires PostGIS data directly

### Example:
```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

c = canvas.Canvas("map_report.pdf", pagesize=A4)
# Draw map image
c.drawImage("map.png", 50, 500, width=500, height=400)
c.save()
```

### Best For:
- Django integration (native)
- Report generation with maps
- Simple static maps

---

## 5. 🖼️ **GeoServer Web Processing Service (WPS)**

**Server-side GIS processing**

### Pros:
- ✅ OGC standard
- ✅ Works with PostGIS directly
- ✅ High-quality cartography
- ✅ Render complex GIS features

### Cons:
- ❌ Complex setup
- ❌ Requires Java server
- ❌ Slower than Mapnik

### Integration:
```xml
<!-- WPS request -->
<wps:Execute service="WPS">
  <ows:Identifier>gs:RasterAsPointCollection</ows:Identifier>
  <!-- parameters -->
</wps:Execute>
```

### Best For:
- Integration with existing GeoServer
- Complex GIS workflows
- Spatial analysis + rendering

---

## 6. 📄 **PDFKit / PDFLib (JavaScript)**

**Pure JavaScript PDF generation**

### Pros:
- ✅ No server needed
- ✅ Works in browser + Node.js
- ✅ Fine-grained PDF control

### Cons:
- ❌ Can't capture WebGL maps
- ❌ Limited to SVG/canvas output

### Example:
```javascript
import PDFDocument from 'pdfkit';

const doc = new PDFDocument();
doc.image('map.png', 50, 50, { width: 500 });
doc.pipe(fs.createWriteStream('map.pdf'));
doc.end();
```

---

## 7. 🎯 **Leaflet-Print Plugins**

**Leaflet-specific print solutions**

### Popular Options:
- **leaflet-print-2** - Client-side printing
- **leaflet-easyprint** - Simple button-based
- **Leaflet.awesome-markers** + **html2canvas**

### Pros:
- ✅ Simple integration
- ✅ Small file size
- ✅ No server needed

### Cons:
- ❌ Limited resolution
- ❌ CSS/styling issues
- ❌ Can't capture complex layouts

---

## 8. 🚀 **Sharp / ImageMagick**

**Server-side image manipulation**

### Pros:
- ✅ Convert screenshots to various formats
- ✅ Image optimization
- ✅ Batch processing

### Cons:
- ❌ Still needs initial screenshot
- ❌ Additional layer on top of other tools

---

## Recommendation for RakshaGIS

### 🥇 **Best Overall: Puppeteer + ReportLab Hybrid**

```
Client (React):
  ↓ User clicks "Print Map"
  ↓ Sends map state + GeoJSON to server
  
Server (Django):
  ↓ Uses Puppeteer to render at high resolution
  ↓ Uses ReportLab to create PDF with report
  ↓ Returns PDF to client
  
Client:
  ↓ Downloads PDF with map + analysis
```

### Why This Approach?
1. **High Quality** - Puppeteer captures exact map state
2. **Professional Reports** - ReportLab adds content
3. **Django Native** - Both integrate well with Django
4. **Flexible** - Supports all map types (OpenLayers, WebGL, etc.)
5. **Scalable** - Can run on separate worker processes

### Alternative for Ultra-Performance: Mapnik
- If you need to generate 100+ maps/day
- Switch to Mapnik for server-side rendering
- Requires separate setup but much faster

---

## Implementation Phases

### Phase 1 (Current - Quick Win)
- Improve jsPDF with better CSS handling
- Add hi-DPI support (2x resolution)
- Cost: Low effort, modest improvement

### Phase 2 (Recommended)
- Add Puppeteer backend for high-quality export
- Keep jsPDF for quick previews
- Cost: Medium effort, professional quality

### Phase 3 (Advanced)
- Integrate Mapnik for batch operations
- Custom map styling (CartoCSS)
- Cost: High effort, publication-grade quality

---

## Code Example: Puppeteer Implementation

### Django View
```python
import asyncio
from django.http import FileResponse
from pyppeteer import launch

async def export_map_pdf(request):
    data = request.POST
    map_url = f"/map/export?project={data['project']}&zoom={data['zoom']}"
    
    browser = await launch()
    page = await browser.newPage()
    await page.goto(map_url, waitUntil='networkidle0')
    
    pdf = await page.pdf(format='A4', scale=2)
    await browser.close()
    
    return FileResponse(pdf, filename='map.pdf')
```

### React Component
```typescript
async function exportMap() {
  const mapState = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    layers: getActiveLayersConfig(),
  }
  
  const response = await fetch('/api/export-map/', {
    method: 'POST',
    body: JSON.stringify(mapState),
  })
  
  const blob = await response.blob()
  downloadFile(blob, 'map.pdf')
}
```

---

## Summary Table

| Tool | Quality | Speed | Server | Setup | Best For |
|------|---------|-------|--------|-------|----------|
| jsPDF (current) | ⭐⭐ | ⭐⭐⭐⭐⭐ | No | ⭐ | Quick previews |
| **Puppeteer** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Yes | ⭐⭐⭐ | **Production** |
| Mapnik | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Yes | ⭐⭐⭐⭐⭐ | Batch/Volume |
| ReportLab | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Yes | ⭐⭐ | Reports |
| GeoServer WPS | ⭐⭐⭐⭐ | ⭐⭐⭐ | Yes | ⭐⭐⭐⭐ | Complex GIS |
| Maplibre GL | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | No | ⭐⭐ | WebGL maps |
| Leaflet-Print | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | No | ⭐ | Simple use |

---

## Next Steps for RakshaGIS

1. **Short-term**: Improve current jsPDF with:
   - Hi-DPI screenshots (2x or 3x)
   - Better CSS media queries
   - Custom map size selection
   - Legend/compass/scale bar overlay

2. **Medium-term**: Add Puppeteer backend for:
   - High-quality PDF export
   - GeoJSON + map integration
   - Report generation

3. **Long-term**: Consider Mapnik if:
   - Volume > 1000 maps/month
   - Need custom cartography
   - Want publication-grade quality

---

**Recommendation: Start with Puppeteer + ReportLab combo for professional maps with minimal backend complexity.** 🎯
