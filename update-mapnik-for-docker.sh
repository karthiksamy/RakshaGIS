#!/bin/bash

# Update Mapnik style file to use host.docker.internal instead of localhost
# This allows Docker container to connect to host PostgreSQL database

set -e

STYLE_FILE="services/mapnik/styles/boundaries.xml"
DB_USER="${DB_USER:-raksha}"
DB_NAME="${DB_NAME:-rakshagis}"
DB_PASSWORD="${DB_PASSWORD}"

# Load from .env if not set
if [ -z "$DB_PASSWORD" ]; then
    if [ -f ".env" ]; then
        export $(grep DB_PASSWORD .env | xargs)
        echo "✓ Loaded DB_PASSWORD from .env"
    fi
fi

if [ -z "$DB_PASSWORD" ]; then
    echo "✗ Error: DB_PASSWORD not set and not found in .env"
    echo "  Set it: export DB_PASSWORD=your_password"
    echo "  Or in .env: DB_PASSWORD=your_password"
    exit 1
fi

echo "Updating Mapnik style for Docker..."
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo "  Host: host.docker.internal (Docker → Host)"

# Backup original
cp "$STYLE_FILE" "${STYLE_FILE}.backup"
echo "✓ Backed up original to ${STYLE_FILE}.backup"

# Replace localhost with host.docker.internal in all datasource sections
sed -i.bak \
    -e "s|<Parameter name=\"host\">localhost</Parameter>|<Parameter name=\"host\">host.docker.internal</Parameter>|g" \
    -e "s|<Parameter name=\"user\">raksha</Parameter>|<Parameter name=\"user\">$DB_USER</Parameter>|g" \
    -e "s|<Parameter name=\"password\">change-me</Parameter>|<Parameter name=\"password\">$DB_PASSWORD</Parameter>|g" \
    -e "s|<Parameter name=\"dbname\">rakshagis</Parameter>|<Parameter name=\"dbname\">$DB_NAME</Parameter>|g" \
    "$STYLE_FILE"

echo "✓ Updated $STYLE_FILE"

# Verify changes
if grep -q "host.docker.internal" "$STYLE_FILE"; then
    echo "✓ Successfully updated to host.docker.internal"
else
    echo "✗ Update failed - host.docker.internal not found"
    mv "${STYLE_FILE}.bak" "$STYLE_FILE"
    exit 1
fi

if grep -q "change-me" "$STYLE_FILE"; then
    echo "⚠ Warning: Found 'change-me' in file - password may not be set"
    echo "  Update manually: nano $STYLE_FILE"
else
    echo "✓ Password updated"
fi

echo ""
echo "Next steps:"
echo "  1. Review the changes:"
echo "     grep -A3 'host.docker.internal' $STYLE_FILE"
echo ""
echo "  2. If needed, restore backup:"
echo "     cp ${STYLE_FILE}.backup $STYLE_FILE"
echo ""
echo "  3. Build Docker image:"
echo "     docker compose build web"
echo ""
echo "  4. Start services:"
echo "     docker compose up -d"
echo ""
echo "  5. Test:"
echo "     docker compose exec web python3 -c \"from apps.core.services.mapnik_service import get_mapnik_service; print('✓ Mapnik loaded')\""
