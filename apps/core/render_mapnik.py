#!/usr/bin/env python3
import argparse
import os
import sys
import math
import xml.etree.ElementTree as ET

# Ensure mapnik can be imported
try:
    import mapnik
except ImportError as e:
    sys.stderr.write(f"Error importing mapnik: {e}\n")
    sys.exit(1)

def get_modified_style_xml(xml_path):
    """
    Reads the Mapnik style XML, replaces database connection parameters
    dynamically from environment variables, and returns the modified XML string.
    """
    if not os.path.exists(xml_path):
        raise FileNotFoundError(f"Style file not found at: {xml_path}")

    tree = ET.parse(xml_path)
    root = tree.getroot()

    db_name = os.environ.get('DB_NAME', 'rakshagis')
    db_user = os.environ.get('DB_USER', 'raksha')
    db_password = os.environ.get('DB_PASSWORD', 'raksha_dev_pass')
    db_host = os.environ.get('DB_HOST', 'db')
    db_port = os.environ.get('DB_PORT', '5432')

    for datasource in root.findall('.//Datasource'):
        for parameter in datasource.findall('Parameter'):
            name = parameter.get('name')
            if name == 'host':
                parameter.text = db_host
            elif name == 'port':
                parameter.text = db_port
            elif name == 'dbname':
                parameter.text = db_name
            elif name == 'user':
                parameter.text = db_user
            elif name == 'password':
                parameter.text = db_password

    return ET.tostring(root, encoding='utf-8').decode('utf-8')

def main():
    parser = argparse.ArgumentParser(description="Render a Mapnik style into an image format")
    parser.add_argument('--style', required=True, help="Style XML name (excluding path and extension)")
    parser.add_argument('--width', type=int, default=1200, help="Image width in pixels")
    parser.add_argument('--height', type=int, default=800, help="Image height in pixels")
    parser.add_argument('--zoom', type=float, default=10, help="Zoom level (OpenLayers scale)")
    parser.add_argument('--center-lon', type=float, required=True, help="Center longitude (degrees)")
    parser.add_argument('--center-lat', type=float, required=True, help="Center latitude (degrees)")
    parser.add_argument('--format', default='png', help="Output format (e.g. png, jpeg, pdf)")

    args = parser.parse_args()

    # Find the style file
    # Styles are usually in services/mapnik/styles/
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    styles_dir = os.path.join(base_dir, 'services', 'mapnik', 'styles')
    style_path = os.path.join(styles_dir, f"{args.style}.xml")

    try:
        xml_string = get_modified_style_xml(style_path)
    except Exception as e:
        sys.stderr.write(f"Failed to prepare style sheet: {e}\n")
        sys.exit(1)

    try:
        m = mapnik.Map(args.width, args.height)
        mapnik.load_map_from_string(m, xml_string, False, styles_dir)

        # Coordinate systems: EPSG:4326 to EPSG:3857 (Web Mercator)
        merc = mapnik.Projection('+proj=merc +a=6378137 +b=6378137 +over')
        longlat = mapnik.Projection('+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs')
        transform = mapnik.ProjTransform(longlat, merc)

        # Forward project center
        center_merc = transform.forward(mapnik.Coord(args.center_lon, args.center_lat))

        # Resolution formula (meters per pixel at zoom level args.zoom)
        # circumference of earth = 2 * pi * 6378137
        circumference = 2.0 * math.pi * 6378137.0
        resolution = circumference / (256.0 * (2.0 ** args.zoom))

        # Calculate bounding box
        half_w = (args.width * resolution) / 2.0
        half_h = (args.height * resolution) / 2.0

        bbox = mapnik.Box2d(
            center_merc.x - half_w,
            center_merc.y - half_h,
            center_merc.x + half_w,
            center_merc.y + half_h
        )

        m.zoom_to_box(bbox)

        # Render to image
        im = mapnik.Image(args.width, args.height)
        mapnik.render(m, im)

        # Output raw image bytes
        image_bytes = im.tostring(args.format)
        sys.stdout.buffer.write(image_bytes)

    except Exception as e:
        sys.stderr.write(f"Mapnik rendering failed: {e}\n")
        sys.exit(1)

if __name__ == '__main__':
    main()
