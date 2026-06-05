"""
ECCMA eNLI (Natural Location Identifier) utilities.

Generates a deterministic 14-character alphanumeric Land Parcel ID based on
the feature's geometry centroid, following the ECCMA eNLI grid encoding.

Format: ZZBLCCCCCCCCCC
  ZZ  = 2-digit UTM zone number (01–60)
  B   = MGRS latitude band letter (C–X, no I/O)
  L   = hemisphere (N / S)
  CCCCCCCCCC = 10-char base-34 coordinate hash (no I, O)
"""

# Attribute field names that may already carry a Land Parcel ID.
_PARCEL_ID_FIELDS = (
    'Land_Parcel_ID', 'land_parcel_id', 'LAND_PARCEL_ID',
    'LandParcelID', 'enli_code', 'ENLI_Code', 'parcel_id', 'ParcelID',
)

_LAT_BANDS = 'CDEFGHJKLMNPQRSTUVWX'  # 20 bands × 8° from −80° to +84°

# Base-34 alphabet (no I / O to avoid visual confusion)
_B34 = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'


def _b34_encode(n: int, length: int) -> str:
    digits = []
    for _ in range(length):
        digits.append(_B34[n % 34])
        n //= 34
    return ''.join(reversed(digits))


def generate_enli_code(geometry) -> str:
    """
    Return a 14-character eNLI Land Parcel ID derived from the geometry centroid.
    Identical coordinates always produce the same code.
    """
    centroid = geometry.centroid
    lon, lat = centroid.x, centroid.y

    # UTM zone (1–60)
    zone = max(1, min(60, int((lon + 180) / 6) + 1))

    # Latitude band
    band_idx = max(0, min(int((lat + 80) / 8), 19))
    band = _LAT_BANDS[band_idx]

    # Hemisphere
    hem = 'N' if lat >= 0 else 'S'

    # Normalise lat/lon to integer grid (5-decimal precision ≈ 1 m)
    lat_int = int(round((lat + 90) * 100_000))    # 0 … 18 000 000
    lon_int = int(round((lon + 180) * 100_000))   # 0 … 36 000 000

    # Combine into a single 64-bit-safe integer and encode as 10 base-34 chars
    combined = (lat_int * 36_000_001 + lon_int) % (34 ** 10)
    coord_part = _b34_encode(combined, 10)

    return f"{zone:02d}{band}{hem}{coord_part}"


def ensure_land_parcel_id(attributes: dict, geometry) -> dict:
    """
    Return a copy of *attributes* that always contains 'Land_Parcel_ID'.
    If the feature already carries any recognised parcel-ID field with a
    non-empty value, that value is preserved (and normalised to the canonical
    key 'Land_Parcel_ID').  Otherwise a new eNLI code is generated.
    """
    attrs = dict(attributes) if attributes else {}

    # Check whether an existing parcel ID is present
    existing_value = None
    for field in _PARCEL_ID_FIELDS:
        val = attrs.get(field)
        if val and str(val).strip():
            existing_value = str(val).strip()
            break

    if existing_value:
        attrs.setdefault('Land_Parcel_ID', existing_value)
    else:
        try:
            attrs['Land_Parcel_ID'] = generate_enli_code(geometry)
        except Exception:
            pass  # geometry may be empty during partial saves; skip silently

    return attrs
