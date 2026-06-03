"""
Real C2PA (Coalition for Content Provenance and Authenticity) signing for RakshaGIS.

Embeds a cryptographically *signed* C2PA manifest into supported raster formats
(PNG, JPEG, TIFF, WebP) using the official ``c2pa`` library, and reads/verifies
them back. Unlike the legacy in-house token (apps.core.watermark), a C2PA manifest:

  • is signed with an X.509 certificate (asymmetric) — verifiable by anyone, not forgeable
    without the private key,
  • hard-binds a hash of the asset content, so tampering is detectable,
  • follows the published C2PA spec and is readable by standard tools (c2patool, Adobe, etc).

Formats c2pa cannot embed into (PDF, DOCX, GeoJSON, KML, GPKG, CSV, Shapefile) continue
to use the legacy scheme in apps.core.watermark as a fallback — the caller decides.

Signing credentials: a CA-issued ES256 cert may be supplied via settings
(C2PA_SIGN_CERT_PATH / C2PA_SIGN_KEY_PATH). If absent, a self-signed development
signer is generated once and cached under C2PA_DIR. Replace it with a trusted cert
for production and configure a trust list in the verifying environment.
"""
import datetime
import io
import json
import logging
import os
import threading

from django.conf import settings

logger = logging.getLogger(__name__)

# Formats the bundled c2pa build can embed a manifest into.
_C2PA_EXT = ('.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp')
_MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp',
}
_C2PA_MIMES = {'image/png', 'image/jpeg', 'image/tiff', 'image/webp'}

_signer_lock = threading.Lock()
_cached_creds: dict[str, bytes | None] = {'cert': None, 'key': None}


def is_c2pa_supported(filename: str, mime_type: str = None) -> bool:
    """True if the file's format supports embedding a signed C2PA manifest."""
    if not getattr(settings, 'C2PA_ENABLED', True):
        return False
    name = (filename or '').lower()
    if name.endswith(_C2PA_EXT):
        return True
    if mime_type:
        return mime_type.split(';')[0].strip().lower() in _C2PA_MIMES
    return False


def _mime_for(filename: str, mime_type: str = None) -> str:
    name = (filename or '').lower()
    for ext, m in _MIME_BY_EXT.items():
        if name.endswith(ext):
            return m
    if mime_type:
        base = mime_type.split(';')[0].strip().lower()
        if base in _C2PA_MIMES:
            return base
    return 'image/png'


def _c2pa_dir() -> str:
    d = getattr(settings, 'C2PA_DIR', None) or os.path.join(str(settings.BASE_DIR), 'data', 'c2pa')
    os.makedirs(d, exist_ok=True)
    return d


def _generate_self_signed() -> tuple[bytes, bytes]:
    """Create an ES256 (P-256) signer cert+key that satisfies the C2PA cert profile."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, getattr(settings, 'C2PA_CERT_COUNTRY', 'IN')),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, getattr(settings, 'C2PA_CERT_ORG', 'DGDE RakshaGIS')),
        x509.NameAttribute(NameOID.COMMON_NAME, getattr(settings, 'C2PA_CERT_CN', 'RakshaGIS Provenance Signer')),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        # C2PA signer-certificate profile: end-entity, digitalSignature, emailProtection EKU,
        # plus SKI/AKI (required for the chain to validate).
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=False, key_encipherment=False,
            data_encipherment=False, key_agreement=False, key_cert_sign=False,
            crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return cert_pem, key_pem


def _load_credentials() -> tuple[bytes | None, bytes | None]:
    """Load cert+key PEM from configured paths; else generate & persist a dev pair once."""
    if _cached_creds['cert'] and _cached_creds['key']:
        return _cached_creds['cert'], _cached_creds['key']

    cert_path = getattr(settings, 'C2PA_SIGN_CERT_PATH', '') or os.path.join(_c2pa_dir(), 'rakshagis_signer.crt')
    key_path = getattr(settings, 'C2PA_SIGN_KEY_PATH', '') or os.path.join(_c2pa_dir(), 'rakshagis_signer.key')
    try:
        if os.path.exists(cert_path) and os.path.exists(key_path):
            with open(cert_path, 'rb') as f:
                cert_pem = f.read()
            with open(key_path, 'rb') as f:
                key_pem = f.read()
        else:
            cert_pem, key_pem = _generate_self_signed()
            try:
                with open(cert_path, 'wb') as f:
                    f.write(cert_pem)
                with open(key_path, 'wb') as f:
                    f.write(key_pem)
                os.chmod(key_path, 0o600)
                logger.warning(
                    "C2PA: generated a self-signed development signer at %s. Supply a "
                    "CA-issued cert via C2PA_SIGN_CERT_PATH/C2PA_SIGN_KEY_PATH for production.",
                    cert_path,
                )
            except Exception:
                pass  # in-memory creds still usable even if persistence fails
        _cached_creds['cert'], _cached_creds['key'] = cert_pem, key_pem
        return cert_pem, key_pem
    except Exception as e:
        logger.error("C2PA: failed to load/generate signing credentials: %s", e)
        return None, None


def _make_signer():
    import c2pa
    cert_pem, key_pem = _load_credentials()
    if not cert_pem or not key_pem:
        return None
    # ta_url is a ctypes c_char_p; a non-empty placeholder satisfies the constructor,
    # then we set the real value (or NULL for an air-gapped, no-timestamp deployment).
    info = c2pa.C2paSignerInfo(alg=b'es256', sign_cert=cert_pem, private_key=key_pem, ta_url=b'x')
    tsa = (getattr(settings, 'C2PA_TSA_URL', '') or '').strip()
    info.ta_url = tsa.encode('utf-8') if tsa else None
    return c2pa.Signer.from_info(info)


def _build_manifest(filename: str, mime: str, metadata: dict, dna_hash: str) -> dict:
    org = getattr(settings, 'C2PA_CERT_ORG', 'DGDE RakshaGIS')
    raksha = {'source': 'RakshaGIS/DEMAP', 'dna_hash': dna_hash}
    for k in ('project_id', 'project_number', 'title', 'export_format', 'style',
              'document_id', 'center_lon', 'center_lat', 'zoom'):
        if metadata.get(k) is not None:
            raksha[k] = metadata.get(k)
    generated_by = (metadata.get('uploaded_by') or metadata.get('updated_by')
                    or metadata.get('generated_by'))
    if generated_by:
        raksha['generated_by'] = generated_by
    return {
        'claim_generator_info': [{
            'name': 'RakshaGIS',
            'version': str(getattr(settings, 'RAKSHAGIS_VERSION', '2.0')),
        }],
        'title': filename or 'rakshagis_export',
        'format': mime,
        'assertions': [
            {'label': 'c2pa.actions', 'data': {'actions': [
                {'action': 'c2pa.created', 'softwareAgent': 'RakshaGIS/DEMAP'}]}},
            {'label': 'stds.schema-org.CreativeWork', 'kind': 'Json', 'data': {
                '@context': 'https://schema.org', '@type': 'CreativeWork',
                'publisher': {'@type': 'Organization', 'name': org}}},
            {'label': 'org.rakshagis.provenance', 'kind': 'Json', 'data': raksha},
        ],
    }


def sign_c2pa(file_bytes: bytes, filename: str, mime_type: str,
              metadata: dict, dna_hash: str) -> tuple[bytes, bool]:
    """
    Embed a signed C2PA manifest into ``file_bytes``.
    Returns (signed_bytes, True) on success, or (original_bytes, False) on any failure
    (missing library, unsupported format, signer error) so callers can fall back safely.
    """
    try:
        import c2pa
    except Exception:
        return file_bytes, False

    signer = None
    builder = None
    try:
        with _signer_lock:
            signer = _make_signer()
        if signer is None:
            return file_bytes, False
        mime = _mime_for(filename, mime_type)
        manifest = _build_manifest(filename, mime, metadata or {}, dna_hash)
        builder = c2pa.Builder(json.dumps(manifest))
        src = io.BytesIO(file_bytes)
        dst = io.BytesIO()
        builder.sign(signer, mime, src, dst)
        dst.seek(0)
        return dst.read(), True
    except Exception as e:
        logger.error("C2PA signing failed for %s: %s", filename, e)
        return file_bytes, False
    finally:
        for obj in (builder, signer):
            try:
                if obj is not None:
                    obj.close()
            except Exception:
                pass


def verify_c2pa(file_bytes: bytes, filename: str = None, mime_type: str = None) -> dict | None:
    """
    Read and validate an embedded C2PA manifest.
    Returns a summary dict (with the RakshaGIS provenance assertion and validation
    state) or None when no manifest is present / format unsupported / library missing.
    """
    try:
        import c2pa
    except Exception:
        return None

    mime = _mime_for(filename, mime_type)
    reader = None
    try:
        reader = c2pa.Reader(mime, io.BytesIO(file_bytes))
        parsed = json.loads(reader.json())
        active = parsed.get('active_manifest')
        manifests = parsed.get('manifests', {})
        am = manifests.get(active, {}) if active else {}

        raksha = {}
        for a in am.get('assertions', []):
            if a.get('label') == 'org.rakshagis.provenance':
                raksha = a.get('data', {}) or {}
                break
        try:
            state = str(reader.get_validation_state())
        except Exception:
            state = None
        return {
            'manifest_found': True,
            'active_manifest': active,
            'title': am.get('title'),
            'claim_generator': am.get('claim_generator_info'),
            'validation_state': state,
            'rakshagis': raksha,
        }
    except Exception:
        # No manifest (ManifestNotFound) or unreadable for this format → not C2PA-signed.
        return None
    finally:
        try:
            if reader is not None:
                reader.close()
        except Exception:
            pass
