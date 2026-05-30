# RakshaGIS Production Deployment Guide

This document outlines best practices for deploying RakshaGIS in production environments.

## Pre-Deployment Checklist

- [ ] Server meets [minimum requirements](README.md#system-requirements) (4+ cores, 8+ GB RAM, SSD)
- [ ] Ubuntu 22.04 LTS or Debian 12 with docker/docker-compose installed
- [ ] Ports 80/443 open (and 5432, 6379 if external database access needed)
- [ ] DNS configured (domain name points to server)
- [ ] SSL certificate obtained (via Let's Encrypt) or self-signed
- [ ] PostgreSQL backups configured
- [ ] Monitoring (Prometheus/Grafana) optional but recommended

---

## Step 1: Server Setup

### 1.1 Update System

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential
```

### 1.2 Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

docker --version   # should be 24.0+
docker compose version  # should be v2.20+
```

### 1.3 Create Application Directory

```bash
sudo mkdir -p /opt/rakshagis
sudo chown $USER:$USER /opt/rakshagis
cd /opt/rakshagis
```

### 1.4 Create Data Directory

```bash
# Host data directory (persistent storage)
sudo mkdir -p /data/rakshagis/{postgres,redis,staticfiles,media,backups,logs}
sudo chown 999:999 /data/rakshagis/postgres   # PostgreSQL user
sudo chown 999:999 /data/rakshagis/redis      # Redis user
sudo chown $USER:$USER /data/rakshagis/{staticfiles,media,backups,logs}
chmod 755 /data/rakshagis
```

---

## Step 2: Clone & Configure

```bash
git clone <repo-url> /opt/rakshagis/app
cd /opt/rakshagis/app

# Copy and edit environment
cp .env.example .env
nano .env  # See steps below
```

### Critical .env Settings

```bash
# ── Security ────────────────────
DEBUG=False
SECRET_KEY=<generate-new-secret>  # python -c "import secrets; print(secrets.token_hex(50))"
ALLOWED_HOSTS=your-domain.com,your-server-ip
DJANGO_SETTINGS_MODULE=config.settings.production

# ── Database ────────────────────
DB_NAME=rakshagis
DB_USER=raksha
DB_PASSWORD=<strong-random-password>
DB_HOST=db
DB_PORT=5432

# ── Redis ───────────────────────
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1

# ── OnlyOffice ──────────────────
ONLYOFFICE_JWT_SECRET=<random-secret>
ONLYOFFICE_INTERNAL_BASE_URL=http://nginx

# ── Backup ──────────────────────
BACKUP_ENCRYPTION_KEY=<fernet-key>  # python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
BACKUP_RETENTION_DAYS=30

# ── Data Paths ──────────────────
DATA_DIR=/data/rakshagis
```

---

## Step 3: Build Docker Image

```bash
cd /opt/rakshagis/app

# Build the web image
./build.sh

# Or if offline:
./build.sh --load-images /path/to/RakshaGIS_images.tar.gz
```

---

## Step 4: HTTPS Setup (Let's Encrypt)

```bash
# 1. Start Certbot
docker compose --profile https up -d certbot

# 2. Let it run to generate certificates
docker compose logs -f certbot

# 3. Uncomment HTTPS in .env
# SECURE_SSL_REDIRECT=True
# SECURE_HSTS_SECONDS=31536000

# 4. Verify certs in /data/rakshagis/letsencrypt/
ls /data/rakshagis/letsencrypt/live/your-domain.com/
```

---

## Step 5: Start All Services

```bash
cd /opt/rakshagis/app

# Start core services
./RakshaGIS.sh start

# Check status
./RakshaGIS.sh status

# Watch logs
./RakshaGIS.sh logs
```

---

## Step 6: Initial Setup

```bash
./RakshaGIS.sh manage migrate
./RakshaGIS.sh manage createsuperuser
./RakshaGIS.sh manage seed_basemaps
```

---

## Step 7: Verify Deployment

```bash
# 1. Check all containers are running
docker compose ps
# Should show: web, celery, db, redis, nginx, pg_tileserv all 'Up'

# 2. Check web app is reachable
curl -I http://localhost/api/
# Should return 200 OK

# 3. Check SSL certificate
openssl s_client -connect localhost:443 -servername your-domain.com < /dev/null

# 4. Test superuser login
curl -X POST http://localhost/api/accounts/token/ \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "yourpassword"}'
# Should return access and refresh tokens
```

---

## Security Hardening

### Firewall

```bash
# Allow only HTTP/HTTPS to the world
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

### Fail2Ban (DDoS protection)

```bash
sudo apt-get install -y fail2ban

# Create jail config
sudo tee /etc/fail2ban/jail.local > /dev/null << EOF
[sshd]
enabled = true
maxretry = 5

[nginx-http-auth]
enabled = true
EOF

sudo systemctl restart fail2ban
```

### SSH Hardening

```bash
# Disable root login and password auth
sudo sed -i 's/^#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

### Secrets Management

- Store `.env` file with restrictive permissions: `chmod 600 .env`
- Backup `BACKUP_ENCRYPTION_KEY` securely (in case of data recovery)
- Rotate `ONLYOFFICE_JWT_SECRET` quarterly
- Use a secrets manager (e.g., Vault, Sealed Secrets in K8s) for enterprise deployments

---

## Backup & Restore

### Automated Backups

Configure scheduled backups in the SuperAdmin panel:

1. Log in as SuperAdmin
2. Go to **Backups → Schedules**
3. Add:
   - **Type**: Full Database (for production)
   - **Frequency**: Daily at 2:00 AM UTC
   - **Encryption**: Enabled
   - **Retention**: 30 days

Backups are stored at `/data/rakshagis/backups/` and automatically rotated.

### Manual Backup

```bash
./RakshaGIS.sh backup
# Creates: /data/rakshagis/backups/rakshagis_backup_YYYYMMDD_HHMMSS.sql.gz
```

### Restore from Backup

```bash
./RakshaGIS.sh restore /data/rakshagis/backups/rakshagis_backup_YYYYMMDD_HHMMSS.sql.gz
```

### Off-Site Backup

```bash
# Copy backups to S3 (AWS)
sudo apt-get install -y awscli

aws s3 sync /data/rakshagis/backups s3://your-backup-bucket/rakshagis/ \
  --region us-east-1 --delete

# Or use rsync to another server
rsync -av /data/rakshagis/backups backup-server:/backups/rakshagis/
```

---

## Monitoring & Logging

### Enable Monitoring Stack

```bash
docker compose --profile monitoring up -d prometheus grafana

# Access Prometheus: http://localhost:9090
# Access Grafana: http://localhost:3000 (login: admin / admin)
```

### View Application Logs

```bash
# All logs
./RakshaGIS.sh logs

# Specific service
./RakshaGIS.sh logs web
./RakshaGIS.sh logs celery
./RakshaGIS.sh logs db

# Follow in real-time
docker compose logs -f web

# Last 100 lines
docker compose logs --tail=100 web
```

### Set Up Log Rotation

```bash
sudo tee /etc/logrotate.d/rakshagis > /dev/null << EOF
/data/rakshagis/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 $USER $USER
}
EOF
```

---

## Performance Tuning

### PostgreSQL

```bash
# Edit PostgreSQL config in Docker volume
docker compose exec db psql -U raksha -d rakshagis -c "SHOW config_file;"

# Common tunings:
shared_buffers = 256MB        # 25% of RAM
effective_cache_size = 1GB    # 50% of RAM
work_mem = 10MB               # RAM / (2 * number of cores)
```

### Redis

```bash
# Monitor Redis memory usage
docker compose exec redis redis-cli INFO memory

# Set max memory policy
docker compose exec redis redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

### Django/Daphne

```bash
# Increase worker concurrency in docker-compose.yml
# (Currently 4 workers, adjust to match CPU cores)
```

---

## Scaling

### Horizontal Scaling (Multiple Servers)

For high-traffic deployments, run RakshaGIS across multiple servers:

1. **Database server** (PostgreSQL + PostGIS) — dedicated large instance
2. **Cache server** (Redis) — dedicated instance  
3. **Application servers** (Daphne + Celery) — 2+ load-balanced instances
4. **Reverse proxy** (nginx) — single point of entry

Use docker compose overrides or Kubernetes for orchestration.

### Vertical Scaling (Single Server)

- Add more CPU cores
- Add more RAM (test with Celery worker concurrency)
- Use SSD for database storage

---

## Troubleshooting

### Application won't start

```bash
# Check logs
./RakshaGIS.sh logs web

# Check migrations ran
./RakshaGIS.sh manage showmigrations

# Run migrations manually
./RakshaGIS.sh manage migrate --verbosity=2
```

### Database connection errors

```bash
# Test database connectivity
docker compose exec web python manage.py dbshell

# Check PostgreSQL is running
docker compose ps db

# Check logs
docker compose logs db
```

### Out of disk space

```bash
du -sh /data/rakshagis/*
# Check which directories are large, clean up old backups/logs as needed
```

### Memory issues

```bash
# Check memory usage
free -h
docker stats

# If Celery is using too much memory, reduce concurrency in docker-compose.yml
```

### WebSocket connection failing

```bash
# Check nginx has WebSocket proxy block
grep -A 5 "ws/" deploy/nginx-docker.conf

# Check Redis is running
docker compose ps redis

# Check channel layer connection
docker compose exec web python -c "
from channels.layers import get_channel_layer
import asyncio
cl = get_channel_layer()
asyncio.run(cl.group_add('test', 'ch'))
print('OK')
"
```

---

## Regular Maintenance

### Weekly

```bash
# Check disk usage
df -h /data/rakshagis

# Monitor backup files
ls -lh /data/rakshagis/backups | tail -5
```

### Monthly

```bash
# Update Docker images
./RakshaGIS.sh update

# Verify backups are restorable
./RakshaGIS.sh restore /path/to/test/backup.sql.gz --dry-run

# Check SSL certificate expiry
curl -I https://your-domain.com | grep -i expiry
```

### Quarterly

```bash
# Rotate secrets
# - Generate new ONLYOFFICE_JWT_SECRET
# - Generate new BACKUP_ENCRYPTION_KEY
# - Update .env and redeploy

# Review and clean old backups
ls -lt /data/rakshagis/backups | awk 'NR>31 {print $NF}' | xargs rm
```

---

## Disaster Recovery

### Prepare a Runbook

Document your specific recovery steps:

1. **Database recovery**: which backup, how long to restore
2. **Application recovery**: rebuild Docker images, restart
3. **Data recovery**: restore from backups, verify integrity
4. **Communication**: who to notify, status page updates

### Test Recovery Regularly

- **Monthly**: restore a backup to a test server
- **Quarterly**: do a full failover drill

---

## Support & Escalation

For production issues:

1. Check logs: `./RakshaGIS.sh logs`
2. Review documentation: [README.md](README.md), [Troubleshooting](README.md#troubleshooting)
3. Check git issues: https://github.com/...
4. Contact maintainers with:
   - Server specs (CPU, RAM, disk)
   - Last successful operation
   - Error message from logs
   - Steps to reproduce (if applicable)

---

## Additional Resources

- [Docker Compose Docs](https://docs.docker.com/compose/)
- [PostgreSQL Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Redis Memory Management](https://redis.io/docs/management/admin/memory-management/)
- [nginx Configuration Pitfalls](https://nginx.org/en/docs/http/server_names/)

---

Good luck with your deployment! 🚀
