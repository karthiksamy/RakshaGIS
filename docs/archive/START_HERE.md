# 🚀 START HERE - Get Mapnik Running in 5 Minutes

**Your setup**: Mapnik in Docker + PostgreSQL on your machine

---

## Copy & Paste These Commands

### Step 1: Update Configuration (1 minute)

```bash
cd /home/karthi/RakshaGIS
./update-mapnik-for-docker.sh
```

**Expected output:**
```
✓ Loaded DB_PASSWORD from .env
✓ Successfully updated to host.docker.internal
✓ Password updated
```

> If it fails: See "Troubleshooting" section below

---

### Step 2: Build Docker Image (3-5 minutes)

```bash
docker compose build web
```

**Expected output:**
```
[+] Building 45.5s (10/10) FINISHED
 => => naming to rakshagis:web
```

> This installs: Python, Django, GeoDjango, Mapnik, your code

---

### Step 3: Start Services (1 minute)

```bash
docker compose up -d
```

**Expected output:**
```
[+] Running 4/4
 ✔ Container rakshagis-db-1      Started
 ✔ Container rakshagis-redis-1   Started
 ✔ Container rakshagis-web-1     Started
 ✔ Container rakshagis-nginx-1   Started
```

---

### Step 4: Test Mapnik (30 seconds)

```bash
docker compose exec web python3 << 'EOF'
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
import django
django.setup()
from apps.core.services.mapnik_service import get_mapnik_service
service = get_mapnik_service()
service.load_style('boundaries')
service.set_center_zoom(78.5, 20.5, 10)
png = service.render_png(1200, 800)
print(f"✓ SUCCESS! Rendered {len(png)} bytes from your database!")
EOF
```

**Expected output:**
```
✓ SUCCESS! Rendered XXXXX bytes from your database!
```

---

## 🎉 If You See "SUCCESS" — You're Done!

### Try It In Browser

**Option 1: Development (with hot reload)**
```bash
# Terminal 2:
cd /home/karthi/RakshaGIS/frontend
npm run dev

# Open: http://localhost:5173/map
```

**Option 2: Production**
```bash
# Already running!
# Open: http://localhost/map
```

Look for the **"Export Map"** button → Click it → Download PNG ✅

---

## ❌ Troubleshooting (2-minute fixes)

### Problem: "could not translate host name"

**Fix:**
```bash
# Your DB password is wrong
# Check your actual password:
cat .env | grep DB_PASSWORD

# Update the file:
nano services/mapnik/styles/boundaries.xml

# Find this line and replace password:
# <Parameter name="password">YOUR_ACTUAL_PASSWORD</Parameter>

# Then rebuild:
docker compose build web --no-cache
docker compose restart web

# Test again (Step 4)
```

---

### Problem: "style not found: boundaries"

**Fix:**
```bash
# Rebuild with no cache
docker compose build web --no-cache
docker compose up -d

# Test again (Step 4)
```

---

### Problem: Services won't start

**Fix:**
```bash
# See what's wrong:
docker compose logs web

# Common issue: Port 5432 already in use
# Kill local PostgreSQL:
sudo systemctl stop postgresql

# Or use different port in .env:
# DB_HOST=localhost
# DB_PORT=5433

# Try again:
docker compose down
docker compose build web
docker compose up -d
```

---

### Problem: "docker: command not found"

**Fix:**
```bash
# Docker not installed
# Install Docker Desktop for your OS:
# - Windows: https://www.docker.com/products/docker-desktop/
# - Mac: https://www.docker.com/products/docker-desktop/
# - Linux: sudo apt install docker.io docker-compose
```

---

## 📋 Validation Checklist

Run this if you're not sure everything worked:

```bash
# 1. Check Docker is running
docker ps

# 2. Check all containers are Up
docker compose ps

# 3. Check logs for errors
docker compose logs web

# 4. Check Mapnik is installed in container
docker compose exec web python3 -c "import mapnik; print('✓ Mapnik OK')"

# 5. Check database connection
docker compose exec web python manage.py shell -c "from django.db import connection; connection.ensure_connection(); print('✓ Database OK')"
```

All should show ✓ OK

---

## 📚 Next Steps

### Want more details?
- **Full Docker guide**: `DOCKER_MAPNIK_SETUP.md`
- **Quick reference**: `DOCKER_MAPNIK_QUICKSTART.md`
- **Architecture**: `DOCKER_SETUP_SUMMARY.md`

### Want to expand Mapnik?
- Create more styles: `cp services/mapnik/styles/boundaries.xml services/mapnik/styles/survey.xml`
- Edit colors: `nano services/mapnik/styles/survey.xml`
- Rebuild: `docker compose build web && docker compose up -d`

### Want to deploy?
- Same setup works on any server
- Just copy repo and run Step 1-3
- Data backs up easily: `tar czf backup.tar.gz ~/.rakshagis/`

---

## ⏱️ Timeline

| Step | Time | Cumulative |
|------|------|------------|
| Update config | 1 min | 1 min |
| Build Docker | 3-5 min | 4-6 min |
| Start services | 1 min | 5-7 min |
| Test Mapnik | 1 min | 6-8 min |
| **Setup complete** | | **6-8 min** |
| Test browser | 2-3 min | **8-11 min** |

---

## 🆘 Still Stuck?

1. Copy the error message
2. Check `DOCKER_MAPNIK_SETUP.md` under "Troubleshooting"
3. See full logs: `docker compose logs -f web`
4. Clean rebuild: `docker compose down && docker compose build web --no-cache && docker compose up -d`

---

## ✨ That's It!

Your data stays local, Mapnik runs in Docker, everything is ready to go.

**Questions?** Read `DOCKER_SETUP_SUMMARY.md` or `DOCKER_MAPNIK_SETUP.md`

**Ready to export maps?** Follow the browser steps above → 🗺️ Export Map! 🎉
