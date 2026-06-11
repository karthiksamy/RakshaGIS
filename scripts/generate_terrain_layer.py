#!/usr/bin/env python3
"""Generate a Cesium terrain layer.json with a correct "available" array.

Scans a quantized-mesh tile directory ({z}/{x}/{y}.terrain, as produced by
ctb-tile -f Mesh -C) and writes layer.json next to the tiles. Without the
"available" array, recent Cesium versions fail with:
  "TypeError: can't access property computeChildMaskForTile,
   e.availability is undefined"

Usage:  python3 scripts/generate_terrain_layer.py /path/to/DATA_DIR/terrain
"""
import json
import os
import sys


def y_runs(ys):
    """Collapse a sorted list of ints into (start, end) runs."""
    runs = []
    for y in ys:
        if runs and y == runs[-1][1] + 1:
            runs[-1][1] = y
        else:
            runs.append([y, y])
    return runs


def main():
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        print(__doc__)
        sys.exit(1)
    root = sys.argv[1]

    levels = sorted(int(d) for d in os.listdir(root)
                    if d.isdigit() and os.path.isdir(os.path.join(root, d)))
    if not levels:
        print(f'No zoom-level directories found under {root}')
        sys.exit(1)
    max_z = max(levels)

    available = []
    total = 0
    for z in range(max_z + 1):
        zdir = os.path.join(root, str(z))
        rects = []
        if os.path.isdir(zdir):
            xs = sorted(int(d) for d in os.listdir(zdir)
                        if d.isdigit() and os.path.isdir(os.path.join(zdir, d)))
            for x in xs:
                ys = sorted(int(f[:-8]) for f in os.listdir(os.path.join(zdir, str(x)))
                            if f.endswith('.terrain') and f[:-8].isdigit())
                total += len(ys)
                for y0, y1 in y_runs(ys):
                    # Merge with the previous column when the y-range matches
                    if rects and rects[-1]['endX'] == x - 1 and \
                       rects[-1]['startY'] == y0 and rects[-1]['endY'] == y1:
                        rects[-1]['endX'] = x
                    else:
                        rects.append({'startX': x, 'startY': y0,
                                      'endX': x, 'endY': y1})
        available.append(rects)

    layer = {
        'tilejson': '2.1.0',
        'name': 'India SRTM Terrain',
        'description': 'CGIAR-CSI SRTM v4.1 quantized-mesh tiles',
        'version': '1.0.0',
        'format': 'quantized-mesh-1.0',
        'attribution': 'CGIAR-CSI SRTM v4.1',
        'scheme': 'tms',
        'extensions': ['octvertexnormals'],
        'tiles': ['{z}/{x}/{y}.terrain'],
        'projection': 'EPSG:4326',
        'bounds': [-180.0, -90.0, 180.0, 90.0],
        'minzoom': 0,
        'maxzoom': max_z,
        'available': available,
    }

    out = os.path.join(root, 'layer.json')
    with open(out, 'w') as f:
        json.dump(layer, f)
    rect_count = sum(len(r) for r in available)
    print(f'Wrote {out}')
    print(f'  zoom levels 0-{max_z}, {total} tiles, {rect_count} availability rectangles')


if __name__ == '__main__':
    main()
