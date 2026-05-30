# Docker Mapnik - Quick Start (5 Minutes)

**Goal**: Get Mapnik running in Docker with local database in 5 minutes.

---

## 1️⃣ Update Database Config (1 min)

Run this script to auto-update the Mapnik XML with your database credentials:

```bash
cd /home/karthi/RakshaGIS
./update-mapnik-for-docker.sh
```

**What it does:**
- Changes `localhost` → `host.docker.internal` (Docker can reach host)
- Reads `DB_PASSWORD` from `.env`
- Updates `boundaries.xml` with your credentials
- Creates backup as `boundaries.xml.backup`

**Output should show:**
```
✓ Loaded DB_PASSWORD from .env
✓ Successfully updated to host.docker.internal
✓ Password updated
```

**If it fails:**
- Check `.env` has `DB_PASSWORD=yourpassword`
- Edit manually: `nano services/mapnik/styles/boundaries.xml`

---

## 2️⃣ Build Docker Image (3 min)

```bash
docker compose build web
```

**Expected output:**
```
[+] Building 45.5s (10/10) FINISHED
 => => naming to rakshagis:web
```

This includes:
- ✅ Python environment
- ✅ Django + GeoDjango
- ✅ Mapnik + dependencies
- ✅ Your Mapnik styles (boundaries.xml)

---

## 3️⃣ Start Services (1 min)

```bash
docker compose up -d
```

**Expected output:**
```
[+] Running 4/4
 ✔ Container rakshagis-db-1     Started
 ✔ Container rakshagis-redis-1  Started
 ✔ Container rakshagis-web-1    Started
 ...
```

---

## 4️⃣ Test Mapnik (within 30 seconds)

```bash
docker compose exec web python3 << 'EOF'
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
import django; django.setup()
from apps.core.services.mapnik_service import get_mapnik_service
try:
    service = get_mapnik_service()
    service.load_style('boundaries')
    service.set_center_zoom(78.5, 20.5, 10)
    png = service.render_png(1200, 800)
    print(f"✓ SUCCESS: Mapnik rendered {len(png)} bytes!")
except Exception as e:
    print(f"✗ FAILED: {e}")
EOF
```

**Should output:**
```
✓ SUCCESS: Mapnik rendered XXXXX bytes!
```

---

## 🎉 Done! Try It Out

### Option 1: Frontend Dev Server
```bash
# Terminal 1: Already running from step 3
docker compose logs -f web

# Terminal 2:
cd frontend
npm run dev

# Browser: http://localhost:5173/map
# Look for "Export Map" button
```

### Option 2: Production (Nginx)
```bash
# Build frontend once
cd frontend && npm run build

# Backend is already running
# Browser: http://localhost/map
# Nginx serves on port 80
```

---

## ✅ Validation Checklist

- [ ] Script ran without errors
- [ ] Docker build succeeded
- [ ] Services started (`docker compose ps`)
- [ ] Mapnik test printed "SUCCESS"
- [ ] Can see "Export Map" button
- [ ] Export downloads a PNG file

---

## 🆘 Common Issues (2 min fix)

### ❌ "could not translate host name"
```bash
# Password is wrong
nano services/mapnik/styles/boundaries.xml
# Find: <Parameter name="password">...</Parameter>
# Set to your actual DB password
docker compose build web
docker compose restart web
```

### ❌ Build fails: "E: Unable to locate package mapnik-utils"
```bash
# Wrong Ubuntu version - Mapnik not available
# Use pre-built container instead (skip local install)
docker compose build web --no-cache
```

### ❌ Services won't start
```bash
# Check what's wrong
docker compose logs web
docker compose logs db

# Rebuild from scratch
docker compose down
docker compose build web --no-cache
docker compose up -d
```

### ❌ Port 5432 already in use
```bash
# You have local PostgreSQL running
# Option 1: Stop local PostgreSQL
sudo systemctl stop postgresql

# Option 2: Use local DB, disable Docker DB
docker compose up -d web redis
# Don't use docker-compose db service
```

---

## 📊 What You Just Did

| Component | Location | Status |
|-----------|----------|--------|
| **Database** | Host machine (local) | ✅ Running |
| **Mapnik** | Docker container | ✅ Running |
| **API** | Docker container | ✅ Running |
| **Frontend** | npm dev or Docker | ✅ Ready |
| **Styles** | /app/services/mapnik/ | ✅ Available |

---

## 📚 Next Steps

1. **Create more styles**: `cp services/mapnik/styles/boundaries.xml services/mapnik/styles/survey.xml`
2. **Customize colors**: Edit XML with your colors
3. **Add admin UI**: Let admins create/edit styles
4. **Performance**: Add database indexes on geometry columns
5. **Deploy**: Run on production server (same steps!)

---

## 🚀 Full Documentation

- **Full guide**: `DOCKER_MAPNIK_SETUP.md` (troubleshooting, performance, etc.)
- **Mapnik basics**: `MAPNIK_INTEGRATION.md` (XML syntax, database queries)
- **React component**: `frontend/MAPNIK_INTEGRATION_GUIDE.md` (how to use in your app)
- **Original checklist**: `MAPNIK_CHECKLIST.md` (all options explained)

---

**Time taken**: ~5 minutes ⏱️  
**Your data**: Still on your machine 💾  
**Mapnik**: Running in Docker 🐳  
**Status**: Ready to export maps! 🗺️
