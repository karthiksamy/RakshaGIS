#!/bin/bash
# Verification script for Docker build fixes
# Run this after ./build.sh to verify all fixes are in place

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     RakshaGIS Docker Build Verification                   ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

ERRORS=0

# Check 1: Image naming
echo "▶ Checking Docker image naming..."
if docker image ls | grep -q "rakshagis.*web"; then
  echo "  ✓ Image properly tagged as rakshagis:web"
else
  echo "  ✗ No properly tagged image found"
  echo "    Run: docker image ls | grep rakshagis"
  ERRORS=$((ERRORS + 1))
fi

# Check 2: No orphaned <none> images
echo ""
echo "▶ Checking for orphaned <none> images..."
NONE_COUNT=$(docker image ls | grep "<none>" | wc -l)
if [[ $NONE_COUNT -eq 0 ]]; then
  echo "  ✓ No orphaned <none> images"
else
  echo "  ⚠ Found $NONE_COUNT orphaned <none> images"
  echo "    (Safe to remove: docker image prune -f)"
fi

# Check 3: Docker compose has explicit image field
echo ""
echo "▶ Checking docker-compose.yml configuration..."
if grep -q "image: rakshagis:web" docker-compose.yml; then
  echo "  ✓ docker-compose.yml has explicit image naming"
else
  echo "  ✗ docker-compose.yml missing explicit image field"
  ERRORS=$((ERRORS + 1))
fi

# Check 4: Web container can be started
echo ""
echo "▶ Checking if web container starts..."
if docker compose ps web 2>/dev/null | grep -q "web"; then
  STATUS=$(docker compose ps web --format "{{.Status}}")
  echo "  ✓ Web container status: $STATUS"
else
  echo "  ✗ Web container not running"
  echo "    Run: docker compose up -d"
  ERRORS=$((ERRORS + 1))
fi

# Check 5: Database connectivity
echo ""
echo "▶ Checking database connectivity..."
if docker compose ps db 2>/dev/null | grep -q "db"; then
  echo "  ✓ Database container running"
else
  echo "  ✗ Database container not running"
fi

# Check 6: Migrations applied
echo ""
echo "▶ Checking migrations status..."
if docker compose ps web >/dev/null 2>&1; then
  MIGRATION_COUNT=$(docker compose exec -T web python manage.py showmigrations --plan 2>/dev/null | grep -c "\[X\]" || echo "0")
  if [[ $MIGRATION_COUNT -gt 0 ]]; then
    echo "  ✓ Migrations applied ($MIGRATION_COUNT migrations)"
  else
    echo "  ⚠ No migrations found applied yet"
    echo "    This is normal on first run; they will be applied on service startup"
  fi
fi

# Summary
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
if [[ $ERRORS -eq 0 ]]; then
  echo "║  ✓ All checks passed! Build is working correctly.       ║"
else
  echo "║  ✗ Found $ERRORS error(s). See details above.              ║"
fi
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [[ $ERRORS -gt 0 ]]; then
  echo "For more information, see:"
  echo "  - DOCKER_BUILD_FIXES.md (detailed explanation of fixes)"
  echo "  - README.md (installation guide)"
  exit 1
fi

exit 0
