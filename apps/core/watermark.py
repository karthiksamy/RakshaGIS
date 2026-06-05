import base64
import hashlib
import hmac
import io
import json
import os
import re
import sqlite3
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from django.conf import settings
from cryptography.fernet import Fernet

def get_fernet_cipher() -> Fernet:
    """Derive a secure 32-byte Fernet key from Django's SECRET_KEY."""
    secret = getattr(settings, 'SECRET_KEY', 'default-fallback-key-for-rakshagis-watermark')
    key_hash = hashlib.sha256(secret.encode('utf-8')).digest()
    fernet_key = base64.urlsafe_b64encode(key_hash)
    return Fernet(fernet_key)

def get_secret_key_bytes() -> bytes:
    """Get secret key bytes for HMAC calculation."""
    secret = getattr(settings, 'SECRET_KEY', 'default-fallback-key-for-rakshagis-watermark')
    return secret.encode('utf-8')

# ── Coordinate LSB Perturbation (CLPW) helpers ────────────────────────────────

def get_coordinate_parity_bits(x: float, y: float, secret_key: bytes) -> tuple[int, int]:
    """Calculate target LSB parity bits for a coordinate pair based on 5-decimal hash."""
    # Round to 5 decimals for hash input stability (approx 1.1 meter grid stability)
    key_str = f"{x:.5f},{y:.5f}".encode('utf-8')
    h = hmac.new(secret_key, key_str, hashlib.sha256).digest()
    bx = h[0] % 2
    by = h[1] % 2
    return bx, by

def perturb_point(x: float, y: float, secret_key: bytes) -> tuple[float, float]:
    """Slightly perturb the 8th decimal place of coordinates to match target parities."""
    bx, by = get_coordinate_parity_bits(x, y, secret_key)
    
    # 8th decimal place digit (x * 1e8)
    nx = int(round(x * 1e8))
    ny = int(round(y * 1e8))
    
    if nx % 2 != bx:
        # Move nx to match parity, keeping it closer to original fractional value
        diff = (x * 1e8) - nx
        nx += 1 if diff > 0 else -1
        
    if ny % 2 != by:
        diff = (y * 1e8) - ny
        ny += 1 if diff > 0 else -1
        
    return nx / 1e8, ny / 1e8

def map_coords(coords, fn):
    """Recursively traverse coordinate lists and apply fn on point coordinate pairs."""
    if not isinstance(coords, list):
        return coords
    if len(coords) in (2, 3) and all(isinstance(val, (int, float)) for val in coords):
        new_x, new_y = fn(coords[0], coords[1])
        if len(coords) == 3:
            return [new_x, new_y, coords[2]]
        return [new_x, new_y]
    return [map_coords(c, fn) for c in coords]

def extract_coords(coords) -> list[tuple[float, float]]:
    """Recursively extract all point coordinate pairs from a nested list."""
    res = []
    if not isinstance(coords, list):
        return res
    if len(coords) in (2, 3) and all(isinstance(val, (int, float)) for val in coords):
        res.append((coords[0], coords[1]))
    else:
        for c in coords:
            res.extend(extract_coords(c))
    return res

def detect_clpw_watermark(coords_list: list[tuple[float, float]], secret_key: bytes) -> dict:
    """Analyze a list of coordinate pairs to determine if they match the CLPW watermark parities."""
    if not coords_list:
        return {"matched": False, "confidence": 0.0, "total_checked": 0}
        
    matching_count = 0
    total_checked = 0
    
    for x, y in coords_list:
        bx, by = get_coordinate_parity_bits(x, y, secret_key)
        nx = int(round(x * 1e8))
        ny = int(round(y * 1e8))
        
        if nx % 2 == bx and ny % 2 == by:
            matching_count += 1
        total_checked += 1
        
    if total_checked == 0:
        return {"matched": False, "confidence": 0.0, "total_checked": 0}
        
    match_rate = matching_count / total_checked
    
    # Statistical validation: under null hypothesis, probability of match is 0.25.
    is_matched = False
    confidence = 0.0
    
    if total_checked >= 8:
        if match_rate >= 0.85:
            is_matched = True
            confidence = min(0.999, 1.0 - (0.25 ** total_checked))
        elif match_rate >= 0.70:
            is_matched = True
            confidence = 0.90
    else:
        # Small number of points: require 100% match rate
        if total_checked >= 3 and match_rate == 1.0:
            is_matched = True
            confidence = 1.0 - (0.25 ** total_checked)
            
    return {
        "matched": is_matched,
        "match_rate": match_rate,
        "confidence": confidence,
        "total_checked": total_checked,
        "matching_count": matching_count
    }

# ── Format-specific embedding and detection logic ───────────────────────────

def embed_zip_watermark(file_bytes: bytes, token: str) -> bytes:
    """Embed watermark token inside a ZIP archive as a hidden root file."""
    buf = io.BytesIO(file_bytes)
    new_buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'r') as r_zip:
        with zipfile.ZipFile(new_buf, 'w', zipfile.ZIP_DEFLATED) as w_zip:
            for item in r_zip.infolist():
                if item.filename == '.raksha-wmark':
                    continue
                w_zip.writestr(item, r_zip.read(item.filename))
            w_zip.writestr('.raksha-wmark', token.encode('utf-8'))
    return new_buf.getvalue()

def detect_zip_watermark(file_bytes: bytes) -> str:
    """Extract watermark token from a ZIP archive."""
    buf = io.BytesIO(file_bytes)
    try:
        with zipfile.ZipFile(buf, 'r') as zf:
            if '.raksha-wmark' in zf.namelist():
                return zf.read('.raksha-wmark').decode('utf-8').strip()
    except Exception:
        pass
    return None

# ── OOXML (DOCX/XLSX/PPTX) custom-properties provenance ──────────────────────
# OnlyOffice strips unknown ZIP entries (like .raksha-wmark) when it re-exports a
# document. Custom Properties (docProps/custom.xml) are part of the OOXML spec and
# ARE preserved through OnlyOffice edit → save → download cycles.

_PROPS_NS  = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
_VT_NS     = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
_PROPS_CT  = 'application/vnd.openxmlformats-officedocument.custom-properties+xml'
_PROPS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties'
_FMTID     = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'
_PROP_NAME = 'RakshaGIS_Provenance'


def _make_custom_props_xml(token: str) -> bytes:
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Properties xmlns="{_PROPS_NS}" xmlns:vt="{_VT_NS}">'
        f'<property fmtid="{_FMTID}" pid="2" name="{_PROP_NAME}">'
        f'<vt:lpwstr>{token}</vt:lpwstr>'
        f'</property></Properties>'
    ).encode('utf-8')


def embed_ooxml_provenance(file_bytes: bytes, token: str) -> bytes:
    """
    Embed provenance token in OOXML custom properties (docProps/custom.xml).

    This survives OnlyOffice edit/save/download cycles because custom properties
    are a recognised OOXML part that OnlyOffice reads and re-emits intact.
    Also writes the legacy .raksha-wmark entry for backward compatibility.
    """
    buf = io.BytesIO(file_bytes)
    new_buf = io.BytesIO()
    try:
        with zipfile.ZipFile(buf, 'r') as r_zip:
            names = set(r_zip.namelist())

            # ── Build updated docProps/custom.xml ────────────────────────────
            if 'docProps/custom.xml' in names:
                try:
                    tree = ET.fromstring(r_zip.read('docProps/custom.xml'))
                    # Remove any existing RakshaGIS_Provenance property
                    for prop in tree.findall(f'{{{_PROPS_NS}}}property'):
                        if prop.get('name') == _PROP_NAME:
                            tree.remove(prop)
                    max_pid = max(
                        (int(p.get('pid', 2)) for p in tree.findall(f'{{{_PROPS_NS}}}property')),
                        default=1,
                    )
                    prop_el = ET.SubElement(tree, f'{{{_PROPS_NS}}}property')
                    prop_el.set('fmtid', _FMTID)
                    prop_el.set('pid', str(max_pid + 1))
                    prop_el.set('name', _PROP_NAME)
                    ET.SubElement(prop_el, f'{{{_VT_NS}}}lpwstr').text = token
                    inner = ET.tostring(tree, encoding='unicode')
                    custom_xml_bytes = (
                        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                        + inner
                    ).encode('utf-8')
                except Exception:
                    custom_xml_bytes = _make_custom_props_xml(token)
            else:
                custom_xml_bytes = _make_custom_props_xml(token)

            # ── Ensure [Content_Types].xml references custom.xml ─────────────
            ct_bytes = r_zip.read('[Content_Types].xml')
            ct_str = ct_bytes.decode('utf-8')
            if _PROPS_CT not in ct_str:
                override = f'<Override PartName="/docProps/custom.xml" ContentType="{_PROPS_CT}"/>'
                ct_str = ct_str.replace('</Types>', override + '</Types>')
                ct_bytes = ct_str.encode('utf-8')

            # ── Ensure _rels/.rels has the custom-properties relationship ─────
            rels_bytes = r_zip.read('_rels/.rels')
            rels_str = rels_bytes.decode('utf-8')
            if _PROPS_REL not in rels_str:
                existing_ids = re.findall(r'Id="(rId\d+)"', rels_str)
                max_id = max((int(i[3:]) for i in existing_ids if i.startswith('rId')), default=0)
                rel_tag = (
                    f'<Relationship Id="rId{max_id + 1}" Type="{_PROPS_REL}"'
                    f' Target="docProps/custom.xml"/>'
                )
                rels_str = rels_str.replace('</Relationships>', rel_tag + '</Relationships>')
                rels_bytes = rels_str.encode('utf-8')

            # ── Rebuild ZIP ───────────────────────────────────────────────────
            skip = {'docProps/custom.xml', '[Content_Types].xml', '_rels/.rels', '.raksha-wmark'}
            with zipfile.ZipFile(new_buf, 'w', zipfile.ZIP_DEFLATED) as w_zip:
                for item in r_zip.infolist():
                    if item.filename not in skip:
                        w_zip.writestr(item, r_zip.read(item.filename))
                w_zip.writestr('docProps/custom.xml', custom_xml_bytes)
                w_zip.writestr('[Content_Types].xml', ct_bytes)
                w_zip.writestr('_rels/.rels', rels_bytes)
                w_zip.writestr('.raksha-wmark', token.encode('utf-8'))  # legacy fallback

        return new_buf.getvalue()
    except Exception:
        raise  # let the caller's try/except handle the fallback to embed_zip_watermark


def detect_ooxml_provenance(file_bytes: bytes) -> str | None:
    """
    Extract provenance token from OOXML custom properties.
    Checks docProps/custom.xml first (survives OnlyOffice), then .raksha-wmark (legacy).
    """
    try:
        buf = io.BytesIO(file_bytes)
        with zipfile.ZipFile(buf, 'r') as zf:
            names = zf.namelist()
            if 'docProps/custom.xml' in names:
                try:
                    tree = ET.fromstring(zf.read('docProps/custom.xml'))
                    for prop in tree.findall(f'{{{_PROPS_NS}}}property'):
                        if prop.get('name') == _PROP_NAME:
                            val = prop.find(f'{{{_VT_NS}}}lpwstr')
                            if val is not None and val.text:
                                return val.text.strip()
                except Exception:
                    pass
            if '.raksha-wmark' in names:
                return zf.read('.raksha-wmark').decode('utf-8').strip()
    except Exception:
        pass
    return None

def embed_tail_comment_watermark(file_bytes: bytes, token: str) -> bytes:
    """Embed watermark token as a safe comment appended to the end of a file (PDF, TIFF)."""
    # Ensure there's a trailing newline, then append comment
    sep = b'\n' if not file_bytes.endswith(b'\n') else b''
    trailer = sep + f"%RAKSHA_WMARK:{token}\n".encode('utf-8')
    return file_bytes + trailer

def detect_tail_comment_watermark(file_bytes: bytes) -> str:
    """Search for trailing watermark comments in raw file bytes."""
    # Look for the last occurrence of the pattern in the file bytes
    pattern = re.compile(rb'%RAKSHA_WMARK:([a-zA-Z0-9_\-=]+)')
    matches = pattern.findall(file_bytes)
    if matches:
        return matches[-1].decode('utf-8')
    return None

def embed_geojson_watermark(file_bytes: bytes, token: str, secret_key: bytes) -> bytes:
    """Embed watermark in a GeoJSON dataset using metadata fields and CLPW."""
    try:
        data = json.loads(file_bytes.decode('utf-8'))
    except Exception:
        return file_bytes
        
    data['raksha_watermark'] = token
    
    if 'features' in data and isinstance(data['features'], list):
        for feature in data['features']:
            if isinstance(feature, dict):
                if 'properties' not in feature:
                    feature['properties'] = {}
                feature['properties']['raksha_watermark'] = token
                
                # NOTE: coordinate values are deliberately left intact. RakshaGIS no
                # longer perturbs survey coordinates to embed a watermark — altering
                # authoritative cadastral measurements is indefensible for a land-records
                # system and the perturbation did not survive reprojection/rounding anyway.
                # Provenance rides in the metadata property above + the Trust Registry.

    return json.dumps(data, indent=2).encode('utf-8')

def detect_geojson_watermark(file_bytes: bytes, secret_key: bytes) -> dict:
    """Verify watermark in GeoJSON content."""
    res = {"watermarked": False, "token": None, "clpw": None}
    try:
        data = json.loads(file_bytes.decode('utf-8'))
    except Exception:
        return res
        
    # Check top-level metadata
    if isinstance(data, dict) and 'raksha_watermark' in data:
        res["token"] = data['raksha_watermark']
        res["watermarked"] = True
        
    # Check CLPW
    coords_list = []
    if isinstance(data, dict) and 'features' in data and isinstance(data['features'], list):
        for feature in data['features']:
            if isinstance(feature, dict) and 'geometry' in feature and isinstance(feature['geometry'], dict):
                geom = feature['geometry']
                if 'coordinates' in geom:
                    coords_list.extend(extract_coords(geom['coordinates']))
                    
    if coords_list:
        clpw_res = detect_clpw_watermark(coords_list, secret_key)
        res["clpw"] = clpw_res
        if clpw_res["matched"]:
            res["watermarked"] = True
            
    return res

def embed_kml_watermark(file_bytes: bytes, token: str, secret_key: bytes) -> bytes:
    """Embed watermark in KML structure and coordinate lists."""
    try:
        ET.register_namespace('', 'http://www.opengis.net/kml/2.2')
        root = ET.fromstring(file_bytes)

        # NOTE: coordinates are left intact (no perturbation) — see embed_geojson_watermark.

        # Append ExtendedData to Document or Folder
        document_elem = None
        for child in root:
            if child.tag.endswith('Document') or child.tag.endswith('Folder'):
                document_elem = child
                break
        if document_elem is None:
            document_elem = root
            
        ext_data = ET.Element('{http://www.opengis.net/kml/2.2}ExtendedData')
        data_el = ET.SubElement(ext_data, '{http://www.opengis.net/kml/2.2}Data', name='raksha_watermark')
        val_el = ET.SubElement(data_el, '{http://www.opengis.net/kml/2.2}value')
        val_el.text = token
        
        document_elem.append(ext_data)
        return ET.tostring(root, encoding='utf-8')
    except Exception:
        return file_bytes

def detect_kml_watermark(file_bytes: bytes, secret_key: bytes) -> dict:
    """Verify watermark in KML content."""
    res = {"watermarked": False, "token": None, "clpw": None}
    try:
        content = file_bytes.decode('utf-8', errors='ignore')
        # XML search
        match = re.search(r'name=["\']raksha_watermark["\'].*?<value>(.*?)</value>', content, re.DOTALL)
        if match:
            res["token"] = match.group(1).strip()
            res["watermarked"] = True
            
        # CLPW search
        coords_list = []
        for coord_block in re.findall(r'<coordinates>(.*?)</coordinates>', content, re.DOTALL):
            for coord_str in coord_block.strip().split():
                parts = coord_str.split(',')
                if len(parts) >= 2:
                    try:
                        coords_list.append((float(parts[0]), float(parts[1])))
                    except ValueError:
                        pass
        if coords_list:
            clpw_res = detect_clpw_watermark(coords_list, secret_key)
            res["clpw"] = clpw_res
            if clpw_res["matched"]:
                res["watermarked"] = True
    except Exception:
        pass
    return res

def embed_gpkg_watermark(file_bytes: bytes, token: str) -> bytes:
    """Embed watermark in GPKG SQLite database by writing a dedicated metadata table."""
    with tempfile.NamedTemporaryFile(suffix='.gpkg', delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_name = tmp.name
        
    try:
        conn = sqlite3.connect(tmp_name)
        cursor = conn.cursor()
        cursor.execute("CREATE TABLE IF NOT EXISTS raksha_watermark (token TEXT)")
        cursor.execute("DELETE FROM raksha_watermark")
        cursor.execute("INSERT INTO raksha_watermark (token) VALUES (?)", (token,))
        conn.commit()
        conn.close()
        
        with open(tmp_name, 'rb') as f:
            watermarked_bytes = f.read()
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)
            
    return watermarked_bytes

def detect_gpkg_watermark(file_bytes: bytes) -> str:
    """Verify watermark in GPKG SQLite database."""
    if not file_bytes.startswith(b'SQLite format 3'):
        return None
        
    with tempfile.NamedTemporaryFile(suffix='.gpkg', delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_name = tmp.name
        
    token = None
    try:
        conn = sqlite3.connect(tmp_name)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='raksha_watermark'")
        if cursor.fetchone():
            cursor.execute("SELECT token FROM raksha_watermark LIMIT 1")
            row = cursor.fetchone()
            if row:
                token = row[0]
        conn.close()
    except Exception:
        pass
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)
            
    return token

def embed_csv_watermark(file_bytes: bytes, token: str) -> bytes:
    """Prepend a comment line to CSV files containing the watermark."""
    header = f"# RAKSHA_WMARK:{token}\n".encode('utf-8')
    return header + file_bytes

def detect_csv_watermark(file_bytes: bytes) -> str:
    """Detect watermark comment line in CSV files."""
    try:
        content = file_bytes.decode('utf-8', errors='ignore')
        # Check first 5 lines
        for line in content.splitlines()[:5]:
            if line.startswith('# RAKSHA_WMARK:'):
                return line.split(':', 1)[1].strip()
    except Exception:
        pass
    return None

def embed_image_metadata_watermark(file_bytes: bytes, token: str, filename: str) -> bytes:
    """Embed watermark in PNG text chunks or JPEG COM markers using Pillow."""
    from PIL import Image
    name = (filename or "").lower()
    try:
        img = Image.open(io.BytesIO(file_bytes))
        out = io.BytesIO()
        if name.endswith('.png'):
            from PIL import PngImagePlugin
            meta = PngImagePlugin.PngInfo()
            for k, v in img.info.items():
                if isinstance(v, str):
                    meta.add_text(k, v)
            meta.add_text("raksha_watermark", token)
            img.save(out, format="PNG", pnginfo=meta)
            return out.getvalue()
        elif name.endswith(('.jpg', '.jpeg')):
            # Write comment marker in JPEG
            img.save(out, format="JPEG", comment=token.encode('utf-8'))
            return out.getvalue()
    except Exception:
        pass
    return file_bytes

def detect_image_metadata_watermark(file_bytes: bytes) -> str:
    """Detect watermark in PNG metadata chunks or JPEG comment markers."""
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(file_bytes))
        if img.format == 'PNG':
            if 'raksha_watermark' in img.info:
                return img.info['raksha_watermark']
        elif img.format == 'JPEG':
            comment = img.info.get('comment')
            if comment:
                if isinstance(comment, bytes):
                    return comment.decode('utf-8', errors='ignore').strip()
                elif isinstance(comment, str):
                    return comment.strip()
    except Exception:
        pass
    return None

# ── Unified public interface ──────────────────────────────────────────────────

def embed_pdf_layers_and_watermark(file_bytes: bytes, token: str, metadata: dict) -> bytes:
    """
    Injects PDF Layers (Optional Content Groups) and applies the tail comment watermark.
    """
    try:
        import fitz
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        
        # Determine layers to create
        layers = metadata.get("layers", [])
        if not layers:
            # Detect images on page 0 to decide layout layers
            if len(doc) > 0:
                page = doc[0]
                img_count = len(page.get_images())
                if img_count == 1:
                    layers = ["Spatial Features"]
                elif img_count >= 2:
                    layers = ["Base Map", "Spatial Features"]
                else:
                    layers = ["Base Map", "Spatial Features"]
            else:
                layers = ["Base Map", "Spatial Features"]

        # Add OCGs (layers)
        ocg_xrefs = []
        for name in layers:
            ocg_xref = doc.add_ocg(name)
            ocg_xrefs.append(ocg_xref)
            
        # Associate images on page 0 with the OCG layers
        if len(doc) > 0:
            page = doc[0]
            images = page.get_images()
            # Sort by xref to preserve bottom-to-top order
            images.sort(key=lambda img: img[0])
            for i, img in enumerate(images):
                if i < len(ocg_xrefs):
                    xref = img[0]
                    doc.set_oc(xref, ocg_xrefs[i])
                    
        # Write back to PDF bytes
        pdf_bytes = doc.tobytes()
        doc.close()
        
        # Append tail comment watermark
        return embed_tail_comment_watermark(pdf_bytes, token)
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.warning(f"Failed to add PDF layers: {e}. Falling back to default watermark.")
        return embed_tail_comment_watermark(file_bytes, token)

def embed_watermark(file_bytes: bytes, filename: str, mime_type: str = None, metadata: dict = None) -> bytes:
    """
    Embed an invisible watermark token containing the given metadata in raw file bytes.
    Additionally registers the unique DNA profile in the Provenance Trust Registry.
    """
    if metadata is None:
        metadata = {}
        
    # Generate unique cryptographic DNA hash
    import uuid
    import hashlib
    # We mix uuid4, settings.SECRET_KEY, and metadata fields to produce a unique, cryptographically strong DNA hash
    secret = getattr(settings, 'SECRET_KEY', 'default-fallback-key-for-rakshagis-watermark')
    raw_dna = f"{uuid.uuid4()}:{filename}:{metadata.get('project_id')}:{secret}"
    dna_hash = hashlib.sha256(raw_dna.encode('utf-8')).hexdigest()

    # Ensure source and DNA details are added to the metadata
    metadata_copy = dict(metadata)
    metadata_copy["source"] = "RakshaGIS/DEMAP"
    metadata_copy["dna_hash"] = dna_hash
    metadata_copy["schema_generation"] = "v2" # Evolving Generational scheme indicator

    # Generate encrypted token using Fernet
    cipher = get_fernet_cipher()
    token = cipher.encrypt(json.dumps(metadata_copy).encode('utf-8')).decode('utf-8')
    
    secret_key = get_secret_key_bytes()
    name = (filename or "").lower()

    # Embed the token in the file bytes according to format
    watermarked_bytes = None

    # 0. Real C2PA signed manifest — the preferred, industry-standard provenance for
    #    supported raster formats (PNG/JPEG/TIFF/WebP). Cryptographically signed and
    #    content-bound. Falls through to the legacy scheme below on any failure.
    try:
        from apps.core.c2pa_provenance import is_c2pa_supported, sign_c2pa
        if is_c2pa_supported(name, mime_type):
            signed_bytes, c2pa_ok = sign_c2pa(file_bytes, filename, mime_type, metadata_copy, dna_hash)
            if c2pa_ok:
                watermarked_bytes = signed_bytes
    except Exception:
        watermarked_bytes = None

    # 1. OOXML Office Docs — embed in docProps/custom.xml so OnlyOffice preserves it
    if name.endswith(('.docx', '.xlsx', '.pptx')):
        try:
            watermarked_bytes = embed_ooxml_provenance(file_bytes, token)
        except Exception:
            pass
        if watermarked_bytes is None:
            try:
                watermarked_bytes = embed_zip_watermark(file_bytes, token)
            except Exception:
                pass

    # 1b. Other ZIP-based formats (plain .zip, Shapefiles)
    if watermarked_bytes is None and (name.endswith('.zip') or (mime_type and 'zip' in mime_type)):
        try:
            watermarked_bytes = embed_zip_watermark(file_bytes, token)
        except Exception:
            pass
            
    # 2. PDF Document
    if watermarked_bytes is None and (name.endswith('.pdf') or (mime_type and 'pdf' in mime_type)):
        watermarked_bytes = embed_pdf_layers_and_watermark(file_bytes, token, metadata)
        
    # 3. GeoJSON / JSON
    if watermarked_bytes is None and (name.endswith(('.geojson', '.json')) or (mime_type and 'json' in mime_type)):
        watermarked_bytes = embed_geojson_watermark(file_bytes, token, secret_key)
        
    # 4. KML
    if watermarked_bytes is None and name.endswith('.kml'):
        watermarked_bytes = embed_kml_watermark(file_bytes, token, secret_key)
        
    # 5. GPKG
    if watermarked_bytes is None and name.endswith('.gpkg'):
        try:
            watermarked_bytes = embed_gpkg_watermark(file_bytes, token)
        except Exception:
            pass
            
    # 6. CSV
    if watermarked_bytes is None and (name.endswith('.csv') or (mime_type and 'csv' in mime_type)):
        watermarked_bytes = embed_csv_watermark(file_bytes, token)
        
    # 7. Images (PNG, JPG/JPEG) - Dual Layer (Metadata + Tail Comment)
    if watermarked_bytes is None and name.endswith(('.png', '.jpg', '.jpeg')):
        try:
            watermarked = embed_image_metadata_watermark(file_bytes, token, name)
            watermarked_bytes = embed_tail_comment_watermark(watermarked, token)
        except Exception:
            pass
        if watermarked_bytes is None:
            watermarked_bytes = embed_tail_comment_watermark(file_bytes, token)

    # 8. GeoTIFF / Other rasters
    if watermarked_bytes is None and name.endswith(('.tif', '.tiff')):
        watermarked_bytes = embed_tail_comment_watermark(file_bytes, token)
        
    # Fallback to appending a safe tail comment
    if watermarked_bytes is None:
        watermarked_bytes = embed_tail_comment_watermark(file_bytes, token)
        
    # Write to local Trust Registry database if Django apps are ready
    try:
        from django.apps import apps
        if apps.ready:
            from apps.core.models import ProvenanceRecord
            file_hash = hashlib.sha256(watermarked_bytes).hexdigest()
            ProvenanceRecord.objects.create(
                dna_hash=dna_hash,
                file_name=filename or "unnamed_export",
                project_id=metadata.get("project_id"),
                project_number=metadata.get("project_number"),
                generated_by=metadata.get("uploaded_by") or metadata.get("updated_by") or "system",
                file_hash=file_hash
            )
    except Exception as e:
        # Ignore registry logging failures in non-django environments (CLI, test setup)
        pass
        
    return watermarked_bytes

def detect_watermark(file_bytes: bytes, filename: str = None, mime_type: str = None) -> dict:
    """
    Scan a file's raw bytes to extract, decrypt, and verify its digital provenance.
    Queries the central Trust Registry to validate ownership history.
    """
    secret_key = get_secret_key_bytes()
    cipher = get_fernet_cipher()
    name = (filename or "").lower()
    
    file_hash = hashlib.sha256(file_bytes).hexdigest()
    token = None
    clpw_info = None

    # 0. Real C2PA signed manifest — checked first for supported raster formats.
    try:
        from apps.core.c2pa_provenance import verify_c2pa
        c2pa_res = verify_c2pa(file_bytes, filename, mime_type)
    except Exception:
        c2pa_res = None
    if c2pa_res and c2pa_res.get("manifest_found"):
        raksha = c2pa_res.get("rakshagis") or {}
        c2pa_dna = raksha.get("dna_hash")
        c2pa_registry_verified = False
        c2pa_registry_record = None
        if c2pa_dna:
            try:
                from django.apps import apps as _apps
                if _apps.ready:
                    from apps.core.models import ProvenanceRecord
                    rec = ProvenanceRecord.objects.filter(dna_hash=c2pa_dna).first()
                    if rec:
                        c2pa_registry_verified = True
                        c2pa_registry_record = {
                            "dna_hash": rec.dna_hash,
                            "file_name": rec.file_name,
                            "project_id": rec.project_id,
                            "project_number": rec.project_number,
                            "generated_by": rec.generated_by,
                            "generated_at": rec.generated_at.isoformat(),
                            "file_hash": rec.file_hash,
                        }
            except Exception:
                pass
        
        c2pa_registry_hash_matched = False
        if c2pa_registry_record and c2pa_registry_record.get("file_hash") == file_hash:
            c2pa_registry_hash_matched = True

        meta = dict(raksha)
        meta.setdefault("source", "RakshaGIS/DEMAP")
        return {
            "watermarked": True,
            "confidence": 1.0,
            "metadata": meta,
            "verification_method": "c2pa_signed_manifest",
            "c2pa": {k: c2pa_res.get(k) for k in
                     ("validation_state", "title", "claim_generator", "active_manifest")},
            "registry_verified": c2pa_registry_verified,
            "registry_record": c2pa_registry_record,
            "registry_hash_matched": c2pa_registry_hash_matched,
        }

    # Try all structural detectors based on file name or magic matching

    _ooxml_mimes = {
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }
    _is_ooxml = name.endswith(('.docx', '.xlsx', '.pptx')) or (
        mime_type and mime_type.split(';')[0].strip().lower() in _ooxml_mimes
    )

    # 1. OOXML Office Docs — check custom.xml first (survives OnlyOffice), then .raksha-wmark
    if _is_ooxml:
        token = detect_ooxml_provenance(file_bytes)

    # 1b. Other ZIP-based formats (plain .zip, Shapefiles)
    if not token and (name.endswith('.zip') or (mime_type and 'zip' in mime_type and not _is_ooxml)):
        token = detect_zip_watermark(file_bytes)
        
    # 2. Images (PNG, JPEG)
    if not token and name.endswith(('.png', '.jpg', '.jpeg')):
        token = detect_image_metadata_watermark(file_bytes)
        if not token:
            token = detect_tail_comment_watermark(file_bytes)

    # 3. PDF / TIFF / General Images (Tail comments)
    if not token and (name.endswith(('.pdf', '.tif', '.tiff', '.webp')) or (mime_type and ('pdf' in mime_type or 'image' in mime_type))):
        token = detect_tail_comment_watermark(file_bytes)
        
    # 4. CSV
    if not token and (name.endswith('.csv') or (mime_type and 'csv' in mime_type)):
        token = detect_csv_watermark(file_bytes)
        
    # 5. GPKG
    if not token and name.endswith('.gpkg'):
        token = detect_gpkg_watermark(file_bytes)
        
    # 6. GeoJSON
    if not token and (name.endswith(('.geojson', '.json')) or (mime_type and 'json' in mime_type)):
        geo_res = detect_geojson_watermark(file_bytes, secret_key)
        token = geo_res.get("token")
        clpw_info = geo_res.get("clpw")
        
    # 7. KML
    if not token and name.endswith('.kml'):
        kml_res = detect_kml_watermark(file_bytes, secret_key)
        if kml_res:
            token = kml_res.get("token")
            clpw_info = kml_res.get("clpw")
            
    # Universal fallback scan
    if not token:
        token = detect_tail_comment_watermark(file_bytes)
        
    decrypted_metadata = {}
    is_valid_token = False
    
    # If a token is found, decrypt it
    if token:
        try:
            decrypted_bytes = cipher.decrypt(token.encode('utf-8'))
            decrypted_metadata = json.loads(decrypted_bytes.decode('utf-8'))
            if isinstance(decrypted_metadata, dict) and decrypted_metadata.get("source") == "RakshaGIS/DEMAP":
                is_valid_token = True
        except Exception:
            pass
            
    # Central Trust Registry Lookup
    registry_verified = False
    registry_record = None
    registry_hash_matched = False
    
    dna_hash = decrypted_metadata.get("dna_hash")
    if dna_hash:
        try:
            from django.apps import apps
            if apps.ready:
                from apps.core.models import ProvenanceRecord
                rec = ProvenanceRecord.objects.filter(dna_hash=dna_hash).first()
                if rec:
                    registry_verified = True
                    registry_record = {
                        "dna_hash": rec.dna_hash,
                        "file_name": rec.file_name,
                        "project_id": rec.project_id,
                        "project_number": rec.project_number,
                        "generated_by": rec.generated_by,
                        "generated_at": rec.generated_at.isoformat(),
                        "file_hash": rec.file_hash,
                    }
                    if rec.file_hash and rec.file_hash == file_hash:
                        registry_hash_matched = True
        except Exception:
            pass
            
    # Verification response construction
    if is_valid_token:
        return {
            "watermarked": True,
            "confidence": 1.0,
            "metadata": decrypted_metadata,
            "verification_method": "structural_cryptographic_signature",
            "registry_verified": registry_verified,
            "registry_record": registry_record,
            "registry_hash_matched": registry_hash_matched,
            "clpw": clpw_info
        }
        
    # Check if CLPW matched (even if metadata token was stripped/absent)
    if clpw_info and clpw_info.get("matched"):
        try:
            from django.apps import apps
            if apps.ready:
                from apps.core.models import ProvenanceRecord
                rec = ProvenanceRecord.objects.filter(file_hash=file_hash).first()
                if rec:
                    registry_verified = True
                    registry_record = {
                        "dna_hash": rec.dna_hash,
                        "file_name": rec.file_name,
                        "project_id": rec.project_id,
                        "project_number": rec.project_number,
                        "generated_by": rec.generated_by,
                        "generated_at": rec.generated_at.isoformat(),
                        "file_hash": rec.file_hash,
                    }
        except Exception:
            pass
            
        # Reconstruct provenance metadata using registry record if found
        metadata_payload = {
            "source": "RakshaGIS/DEMAP",
            "detail": "Identified via Coordinate LSB Perturbation (metadata signature stripped/absent)"
        }
        if registry_record:
            metadata_payload.update({
                "project_id": registry_record["project_id"],
                "project_number": registry_record["project_number"],
                "title": registry_record["file_name"],
                "uploaded_by": registry_record["generated_by"],
            })
            
        return {
            "watermarked": True,
            "confidence": clpw_info.get("confidence", 0.95),
            "metadata": metadata_payload,
            "verification_method": "coordinate_lsb_perturbation",
            "registry_verified": registry_verified,
            "registry_record": registry_record,
            "registry_hash_matched": True if registry_record else False,
            "clpw": clpw_info
        }
        
    return {
        "watermarked": False,
        "confidence": 0.0,
        "metadata": {},
        "verification_method": "none",
        "registry_verified": False,
        "registry_record": None,
        "registry_hash_matched": False
    }

# ── Standalone CLI Interface ─────────────────────────────────────────────────

if __name__ == '__main__':
    import sys
    if len(sys.argv) < 3:
        print("Usage:")
        print("  python -m apps.core.watermark verify <file_path>")
        sys.exit(1)
        
    cmd = sys.argv[1]
    path = sys.argv[2]
    
    if cmd == 'verify':
        if not os.path.exists(path):
            print(f"Error: File '{path}' not found.")
            sys.exit(1)
            
        with open(path, 'rb') as f:
            content = f.read()
            
        res = detect_watermark(content, filename=os.path.basename(path))
        print(json.dumps(res, indent=2))
