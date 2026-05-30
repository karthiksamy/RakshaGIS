"""
ArcGIS-style print layout HTML generator.

All geometry is expressed in millimetres; Playwright renders it at device-pixel
resolution so the output quality scales with the requested paper size / DPI.
"""

from __future__ import annotations

import html as _html
import math
from datetime import date
from typing import Optional

# ── Paper sizes (portrait w × h, mm) ────────────────────────────────────────

PAPER_SIZES: dict[str, tuple[float, float]] = {
    'A0':      (841,  1189),
    'A1':      (594,  841),
    'A2':      (420,  594),
    'A3':      (297,  420),
    'A4':      (210,  297),
    'A5':      (148,  210),
    'Letter':  (216,  279),
    'Legal':   (216,  356),
    'Tabloid': (279,  432),
    'B0':      (1000, 1414),
    'B1':      (707,  1000),
    'B2':      (500,  707),
}


# ── SVG assets (fully self-contained) ────────────────────────────────────────

_NORTH_ARROW_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 52" width="100%" height="100%">
  <!-- Dark (N) half -->
  <polygon points="20,4 13,42 20,34" fill="#1a1a2e"/>
  <!-- Light (S) half -->
  <polygon points="20,4 27,42 20,34" fill="#ffffff"/>
  <!-- Outline -->
  <polygon points="20,4 13,42 27,42" fill="none" stroke="#1a1a2e" stroke-width="1.5"/>
  <!-- Circle behind N -->
  <circle cx="20" cy="6" r="5.5" fill="#1a1a2e"/>
  <!-- N label -->
  <text x="20" y="9.5" text-anchor="middle" font-size="7" font-weight="bold"
        font-family="Arial,sans-serif" fill="#ffffff">N</text>
</svg>"""


def _scale_bar_svg(scale_denom: int, bar_w_mm: float = 36, bar_h_mm: float = 3) -> str:
    """Return an inline SVG scale bar sized to fit in bar_w_mm × (bar_h_mm + 6)mm."""
    nice = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1_000, 2_000, 5_000,
            10_000, 25_000, 50_000, 100_000, 500_000]
    # target real-world distance that fits comfortably in bar_w_mm
    mm_per_m = 1_000 / scale_denom           # mm on paper per metre on ground
    target_m = (bar_w_mm * 0.8) / mm_per_m  # metres represented by 80 % of bar width
    nice_m   = min(nice, key=lambda v: abs(v - target_m))
    bar_mm   = nice_m * mm_per_m             # actual rendered bar width in mm

    label = f'{nice_m // 1000:.0f} km' if nice_m >= 1_000 else f'{nice_m:.0f} m'
    half_label = (f'{nice_m // 2000:.0f} km' if nice_m >= 2_000
                  else f'{nice_m // 2:.0f} m')

    # SVG viewBox in mm units; Playwright honours CSS width/height
    bh = bar_h_mm
    seg = bar_mm / 4  # four alternating segments
    txt_y = bh + 4

    segs = ''
    for i in range(4):
        fill = '#1a1a2e' if i % 2 == 0 else '#ffffff'
        segs += f'<rect x="{i * seg:.2f}" y="0" width="{seg:.2f}" height="{bh}" fill="{fill}" stroke="none"/>'

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg"'
        f' viewBox="0 0 {bar_mm:.2f} {txt_y + 2:.2f}"'
        f' width="{bar_mm:.2f}mm" height="{txt_y + 2:.2f}mm">'
        f'{segs}'
        f'<rect x="0" y="0" width="{bar_mm:.2f}" height="{bh}" fill="none"'
        f' stroke="#1a1a2e" stroke-width="0.4"/>'
        f'<text x="0" y="{txt_y:.1f}" font-size="4.5" font-family="Arial,sans-serif" fill="#333">0</text>'
        f'<text x="{bar_mm / 2:.2f}" y="{txt_y:.1f}" text-anchor="middle"'
        f' font-size="4.5" font-family="Arial,sans-serif" fill="#333">{half_label}</text>'
        f'<text x="{bar_mm:.2f}" y="{txt_y:.1f}" text-anchor="end"'
        f' font-size="4.5" font-family="Arial,sans-serif" fill="#333">{label}</text>'
        f'<text x="0" y="{txt_y + 5:.1f}" font-size="4" font-family="Arial,sans-serif"'
        f' fill="#666" font-style="italic">1 : {scale_denom:,}</text>'
        f'</svg>'
    )


def _legend_items_html(legend: list[dict]) -> str:
    parts = []
    for item in legend:
        name  = _html.escape(item.get('name', ''))
        color = item.get('color', '#888888')
        itype = item.get('type', 'vector')

        if itype == 'raster':
            swatch = (
                '<div style="width:100%;height:100%;'
                'background:linear-gradient(135deg,#a8c4d8 50%,#6699aa 50%)"></div>'
            )
        else:
            swatch = f'<div style="width:100%;height:100%;background:{color}"></div>'

        parts.append(
            f'<div style="display:flex;align-items:center;gap:2mm;margin-bottom:1.8mm;'
            f'min-height:4mm;overflow:hidden">'
            f'  <div style="width:5mm;height:3.5mm;flex-shrink:0;border:0.3px solid rgba(0,0,0,0.25);'
            f'border-radius:0.5px;overflow:hidden">{swatch}</div>'
            f'  <span style="font-size:6pt;color:#1a1a2e;overflow:hidden;text-overflow:ellipsis;'
            f'white-space:nowrap;flex:1">{name}</span>'
            f'</div>'
        )
    return ''.join(parts)


# ── Main export ──────────────────────────────────────────────────────────────

def generate_arcgis_print_html(
    *,
    map_image_b64: str,
    title: str,
    subtitle: str = '',
    org_name: str = '',
    paper_size: str = 'A4',
    orientation: str = 'landscape',
    legend: Optional[list[dict]] = None,
    show_legend: bool = True,
    show_north: bool = True,
    show_scale: bool = True,
    show_coords: bool = True,
    show_attrib: bool = True,
    extent: Optional[dict] = None,
    scale_denominator: int = 0,
    classification: str = '',
) -> str:
    """Return a complete, self-contained HTML document for Playwright to render as PDF."""

    legend = legend or []
    pw, ph = PAPER_SIZES.get(paper_size, (210, 297))
    if orientation == 'landscape':
        pw, ph = max(pw, ph), min(pw, ph)
    else:
        pw, ph = min(pw, ph), max(pw, ph)

    today         = date.today().strftime('%d %b %Y')
    title_safe    = _html.escape(title or 'Map')
    subtitle_safe = _html.escape(subtitle) if subtitle else ''
    org_safe      = _html.escape(org_name) if org_name else ''
    classif_safe  = _html.escape(classification) if classification else ''

    # Layout constants (mm) — scale relative to A4 landscape (297×210)
    scale      = math.sqrt((pw * ph) / (297 * 210))
    outer_pad  = round(6  * scale, 1)
    header_h   = round(18 * scale, 1)
    footer_h   = round(8  * scale, 1)
    gap        = round(2  * scale, 1)
    legend_w   = round(50 * scale, 1) if (show_legend and legend) else 0

    # Build section: coordinate extent
    extent_html = ''
    if show_coords and extent:
        sw_lat = extent.get('sw_lat', 0)
        sw_lon = extent.get('sw_lon', 0)
        ne_lat = extent.get('ne_lat', 0)
        ne_lon = extent.get('ne_lon', 0)
        extent_html = (
            f'SW {sw_lat:.4f}°N {sw_lon:.4f}°E &nbsp;|&nbsp; '
            f'NE {ne_lat:.4f}°N {ne_lon:.4f}°E'
        )

    # Build section: attribution
    attrib_html = ''
    if show_attrib:
        attrib_html = '© RakshaGIS — DGDE Survey Platform &nbsp;'

    # North arrow overlay
    north_size_mm = round(13 * scale, 1)
    north_html = ''
    if show_north:
        north_html = f'''\
<div style="position:absolute;top:{3*scale:.1f}mm;right:{3*scale:.1f}mm;
  width:{north_size_mm}mm;height:{round(north_size_mm*1.3,1)}mm;
  background:rgba(255,255,255,0.92);border:0.4px solid #aab;
  border-radius:{north_size_mm/2:.1f}mm;padding:{north_size_mm*0.08:.1f}mm;
  box-shadow:0 1px 3px rgba(0,0,0,0.15)">
  {_NORTH_ARROW_SVG}
</div>'''

    # Scale bar overlay
    scale_html = ''
    if show_scale and scale_denominator:
        bar_w = round(38 * scale, 1)
        scale_html = f'''\
<div style="position:absolute;bottom:{3*scale:.1f}mm;left:{3*scale:.1f}mm;
  background:rgba(255,255,255,0.92);border:0.4px solid #aab;
  padding:{1.5*scale:.1f}mm {2*scale:.1f}mm;
  box-shadow:0 1px 3px rgba(0,0,0,0.12)">
  {_scale_bar_svg(scale_denominator, bar_w_mm=bar_w, bar_h_mm=3*scale)}
</div>'''

    # Legend panel
    legend_panel_html = ''
    if show_legend and legend and legend_w:
        items_html = _legend_items_html(legend[:40])
        legend_panel_html = f'''\
<div style="width:{legend_w}mm;flex-shrink:0;border:1px solid #2a4a8a;
  display:flex;flex-direction:column;overflow:hidden">
  <div style="background:#0d2b5e;color:#fff;font-size:6.5pt;font-weight:bold;
    letter-spacing:1.5px;text-align:center;padding:{2*scale:.1f}mm;flex-shrink:0">
    LEGEND
  </div>
  <div style="flex:1;padding:{2*scale:.1f}mm;overflow:hidden">
    {items_html}
  </div>
</div>'''

    # Classification banner (top + bottom) — only when set
    classif_html_top = classif_html_bot = ''
    if classif_safe:
        banner_style = (
            f'background:#c00;color:#fff;font-size:6pt;font-weight:bold;'
            f'text-align:center;letter-spacing:2px;padding:0.8mm;flex-shrink:0'
        )
        classif_html_top = f'<div style="{banner_style}">{classif_safe}</div>'
        classif_html_bot = f'<div style="{banner_style}">{classif_safe}</div>'

    # Map image — encode into img src
    map_img_src = f'data:image/png;base64,{map_image_b64}'

    page_w = f'{pw}mm'
    page_h = f'{ph}mm'

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
*, *::before, *::after {{ box-sizing:border-box; margin:0; padding:0; }}

@page {{
  size: {page_w} {page_h};
  margin: 0;
}}

body {{
  width: {page_w};
  height: {page_h};
  font-family: 'Arial', 'Helvetica Neue', Helvetica, sans-serif;
  background: #ffffff;
  overflow: hidden;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}

.page {{
  width: 100%;
  height: 100%;
  padding: {outer_pad}mm;
  display: flex;
  flex-direction: column;
  gap: {gap}mm;
}}

/* ── TITLE BLOCK ── */
.title-block {{
  background: #0d2b5e;
  color: #ffffff;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: {2.5*scale:.1f}mm {4*scale:.1f}mm;
  flex-shrink: 0;
  min-height: {header_h}mm;
  border-bottom: {1.5*scale:.1f}px solid #1e5091;
  position: relative;
}}
.title-block::after {{
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: {1.5*scale:.1f}px;
  background: #3a7bd5;
}}
.tb-left {{
  display: flex;
  flex-direction: column;
  gap: {1*scale:.1f}mm;
}}
.tb-title {{
  font-size: {max(10, round(13*scale, 0)):.0f}pt;
  font-weight: bold;
  letter-spacing: 0.4px;
  color: #ffffff;
}}
.tb-subtitle {{
  font-size: {max(6, round(7.5*scale, 0)):.0f}pt;
  color: #a8c8ec;
}}
.tb-right {{
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: {1*scale:.1f}mm;
  font-size: {max(5.5, round(6.5*scale, 0)):.0f}pt;
  color: #80a8d0;
}}
.tb-org  {{ color: #c0d8f0; font-weight: bold; font-size: {max(6, round(7*scale, 0)):.0f}pt; }}
.tb-date {{ color: #90b8d8; }}
.tb-crs  {{ color: #6888a0; font-style: italic; }}

/* ── CONTENT AREA (map + legend side-by-side) ── */
.content-area {{
  flex: 1;
  display: flex;
  gap: {gap}mm;
  overflow: hidden;
  min-height: 0;
}}

/* ── MAP DATA FRAME ── */
.map-frame {{
  flex: 1;
  border: 1.5px solid #1a3a6a;
  position: relative;
  overflow: hidden;
  background: #d8e4ed;
  min-width: 0;
}}
.map-frame img {{
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}}

/* ── FOOTER ── */
.footer {{
  flex-shrink: 0;
  min-height: {footer_h}mm;
  border-top: 0.4px solid #8090a0;
  padding-top: {1.5*scale:.1f}mm;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  font-size: {max(4.5, round(5.5*scale, 0)):.0f}pt;
  color: #505870;
}}
.footer-mid {{ text-align: center; flex: 1; color: #406080; }}
.footer-page {{ text-align: right; color: #708090; }}

/* ── NEAT LINE (outer page border) ── */
.neat-line {{
  position: fixed;
  inset: {outer_pad * 0.5:.1f}mm;
  border: {0.7*scale:.1f}px solid #3a5a8a;
  pointer-events: none;
  z-index: 999;
}}
</style>
</head>
<body>

<div class="neat-line"></div>

<div class="page">

  {classif_html_top}

  <!-- ── TITLE BLOCK ──────────────────────────────────────────── -->
  <div class="title-block">
    <div class="tb-left">
      <div class="tb-title">{title_safe}</div>
      {'<div class="tb-subtitle">' + subtitle_safe + '</div>' if subtitle_safe else ''}
    </div>
    <div class="tb-right">
      {'<div class="tb-org">' + org_safe + '</div>' if org_safe else ''}
      <div class="tb-date">{today}</div>
      <div class="tb-crs">CRS: WGS 84 / EPSG:4326</div>
    </div>
  </div>

  <!-- ── MAP + LEGEND ─────────────────────────────────────────── -->
  <div class="content-area">

    <!-- Map data frame -->
    <div class="map-frame">
      <img src="{map_img_src}" alt="Map"/>
      {north_html}
      {scale_html}
    </div>

    <!-- Legend panel -->
    {legend_panel_html}

  </div>

  <!-- ── FOOTER ───────────────────────────────────────────────── -->
  <div class="footer">
    <div>{attrib_html}</div>
    <div class="footer-mid">{extent_html}</div>
    <div class="footer-page">Page 1 of 1</div>
  </div>

  {classif_html_bot}

</div>
</body>
</html>"""
