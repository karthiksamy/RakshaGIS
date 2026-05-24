FROM python:3.11-slim

# GeoDjango system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        binutils \
        libproj-dev \
        gdal-bin \
        libgdal-dev \
        libgeos-dev \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd --system --create-home --home-dir /app raksha

WORKDIR /app

# Install Python dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy project
COPY --chown=raksha:raksha . .

# Ensure runtime directories exist with correct ownership
RUN mkdir -p /app/logs && chown raksha:raksha /app/logs

# Entrypoint
COPY --chown=raksha:raksha entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER raksha

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "4", "--timeout", "120", "config.wsgi:application"]
