FROM python:3.11-slim

# GeoDjango + Mapnik + document conversion dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        binutils \
        libproj-dev \
        gdal-bin \
        libgdal-dev \
        libgeos-dev \
        libreoffice-writer \
        fonts-dejavu-core \
        mapnik-utils \
        python3-mapnik \
        libmapnik-dev \
    && pip install --no-cache-dir "GDAL==$(gdal-config --version)" \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

# Non-root user — UID 1000 matches the typical host developer account so the
# bind-mounted source directory (including migrations/) is writable inside the
# container.  --uid 999 is used as a fallback if 1000 is already taken.
RUN useradd --create-home --home-dir /app --uid 1000 raksha 2>/dev/null || \
    useradd --system --create-home --home-dir /app raksha

WORKDIR /app

# Install Python dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy project
COPY --chown=raksha:raksha . .

# Copy Mapnik styles
COPY --chown=raksha:raksha services/mapnik /app/services/mapnik

# Ensure runtime directories exist with correct ownership
RUN mkdir -p /app/logs && chown raksha:raksha /app/logs

# Entrypoint
COPY --chown=raksha:raksha entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER raksha

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "4", "--timeout", "120", "config.wsgi:application"]
