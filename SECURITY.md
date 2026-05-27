# Security Policy — RakshaGIS

## Overview

RakshaGIS handles sensitive defence estate spatial data on behalf of the Directorate General of Defence Estates (DGDE), Government of India. This document describes the security controls implemented in the platform and the responsible disclosure process for any vulnerabilities discovered.

---

## Supported Versions

| Version | Supported |
|---|---|
| 1.x (current) | Yes |
| < 1.0 | No |

---

## Authentication & Session Management

### JSON Web Tokens (SimpleJWT)
- All API endpoints (except `/api/accounts/token/`) require a valid Bearer token.
- Access tokens are short-lived (default: 15 minutes).
- Refresh tokens are longer-lived (default: 7 days) and are rotated on each use.
- Token blacklisting on logout invalidates refresh tokens immediately.
- **Force logout** sets `user.is_active = False`; SimpleJWT rejects all subsequent requests from that user without needing a token blacklist database call.

### Password Policy
- Minimum 8-character passwords enforced at the API layer.
- Passwords are stored using Django's PBKDF2-SHA256 with a unique salt per user (Django default).
- Admins can reset any user's password via a protected endpoint; users can change their own password by supplying their current password first.

---

## Authorisation & Role-Based Access Control

### Role hierarchy
Eight distinct roles control what each user can see and do:

```
SUPERADMIN
  └── DEO_ADMIN / CEO_ADMIN / ADEO_ADMIN  (organisation admins)
        └── SDO / SURVEYOR / CHECKER / APPROVER / VIEWER / PDDE_VIEWER
```

### Row-level security
- Every query is filtered by the user's organisation via `org_queryset_filter()`.
- Users from Organisation A cannot read, write, or enumerate records belonging to Organisation B.
- SUPERADMIN bypasses org filtering.

### Admin-role protection
- `DEO_ADMIN`, `CEO_ADMIN`, `ADEO_ADMIN`, and `SUPERADMIN` accounts cannot be deleted or deactivated by any user — including other admins. This prevents accidental or malicious lockout.

### Write gates
- Feature drawing/editing is restricted to `SDO`, `SURVEYOR`, and `SUPERADMIN`.
- Workflow transitions are gated at the role level — a Viewer cannot submit or approve a project.
- Master data writes (State/District/Taluk/Village) are SUPERADMIN-only.

---

## Data Security

### Transport
- All traffic is served over HTTPS via Nginx.
- HTTP requests are redirected to HTTPS (configure SSL certificates via Certbot — see `docker-compose.yml`).
- HSTS headers should be enabled in production (`Strict-Transport-Security: max-age=31536000`).

### API
- CORS is restricted to explicitly configured origins (`CORS_ALLOWED_ORIGINS`).
- `DEBUG = False` must be set in production — this suppresses stack traces in HTTP responses.
- `ALLOWED_HOSTS` must list only the actual deployment hostnames.
- All DRF views use `IsAuthenticated` as a minimum; write views add role-specific permission classes.

### Database
- PostgreSQL listens only on the internal Docker network — not exposed to the host.
- The application uses a dedicated non-superuser database account.
- All geometry is stored in SRID 4326; PostGIS spatial queries use parameterised inputs (Django ORM) — no raw SQL string interpolation.
- Backups are encrypted at rest (implement at the storage layer for production deployments).

### File Uploads
- Uploaded files are validated for MIME type using `python-magic` (reads file magic bytes, not just the extension).
- Shapefiles are extracted in an isolated temporary directory and cleaned up after import.
- COG (GeoTIFF) files are processed by Celery workers with a configurable timeout.
- Media files are served through Nginx — not Django — to avoid application-level path traversal.
- `MEDIA_ROOT` should be on a dedicated volume with restricted OS-level permissions.

### AI / LLM (Ollama)
- The Ollama inference service runs **fully on-premise** — no document content or user queries leave the deployment host.
- The Ollama API port is not exposed externally; it is only reachable from within the Docker network.
- Document text extracted by pdfplumber is passed only to the local model.

---

## Infrastructure Security

### Docker Compose
- Services communicate over an isolated bridge network (`raksha-net`).
- Only Nginx (`:80`, `:443`) and monitoring ports (`:9090`, `:3000`) are exposed to the host.
- PostgreSQL and Redis ports are **not** published to the host network.
- Containers run as non-root where possible.

### Secrets management
- Secrets (`SECRET_KEY`, database passwords, etc.) are read from environment variables via `django-environ`.
- The `.env` file must **never** be committed to version control (it is listed in `.gitignore`).
- In production, consider using Docker Secrets or a secrets manager instead of `.env` files.

### Monitoring
- Prometheus scrapes Django metrics via `django-prometheus`.
- Grafana dashboards surface request rates, error rates, and database query counts.
- Set up alerting rules in Grafana for 5xx error spikes and authentication failures.

---

## Input Validation

| Input Type | Validation |
|---|---|
| Geometry (GeoJSON) | Parsed by GeoDjango; invalid geometries raise a 400 error |
| Shapefile import | Fiona validates the file structure; unsupported geometry types are rejected |
| Attribute expressions (field calculator) | Evaluated in a sandboxed `Function("use strict"; return(...))` scope; only simple arithmetic is auto-evaluated — string expressions are treated as literals |
| Office ID | 5-character alphanumeric, validated in serializer |
| District ↔ State linkage | Validated in `OrganisationSerializer.validate_district()` |
| File MIME types | Checked via `python-magic` before saving |

---

## Known Limitations & Hardening Recommendations

| Area | Recommendation |
|---|---|
| TLS certificates | Run `certbot renew` via a cron job; auto-renew is pre-configured in `docker-compose.yml` |
| Rate limiting | Add `nginx` rate-limiting directives on `/api/accounts/token/` to mitigate brute-force |
| Audit log retention | Configure log rotation and long-term storage for `AuditLog` records |
| COG files | Restrict bucket/volume ACLs so COG URLs are only accessible via signed or proxied requests |
| Django `SECRET_KEY` | Must be at least 50 characters of random bytes; rotate yearly |
| Session concurrency | Consider adding device tracking if single-session enforcement is required |
| Ollama model | Pin to a known-good model version; update after security advisories |

---

## Reporting a Vulnerability

If you discover a security issue in RakshaGIS, please **do not open a public GitHub issue**.

Contact the maintainer directly:

- **Email:** balusamy.karthikeyan@gmail.com
- **Subject line:** `[RakshaGIS SECURITY] <brief description>`

Please include:
1. Description of the vulnerability and affected component
2. Steps to reproduce (proof-of-concept if possible)
3. Potential impact assessment
4. Your suggested fix (optional)

We will acknowledge your report within **5 business days** and aim to release a patch within **30 days** of confirmation.

---

## Security Changelog

| Date | Change |
|---|---|
| 2026-05-24 | Initial security policy published |
| 2026-05-24 | Admin-role deletion/deactivation protection added |
| 2026-05-24 | Force-logout via `is_active=False` implemented |
| 2026-05-24 | Ollama service isolated to internal Docker network |
| 2026-05-24 | MIME-type validation added for all file uploads |
