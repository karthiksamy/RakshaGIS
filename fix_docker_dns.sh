#!/bin/bash
# Fix Docker DNS resolution failure during builds
# Run this on your Ubuntu host before building

echo "=== Step 1: Check current Docker DNS ==="
docker info | grep -i dns || echo "No custom DNS set"

echo ""
echo "=== Step 2: Fix Docker daemon DNS ==="
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null << 'JSON'
{
  "dns": ["8.8.8.8", "8.8.4.4", "1.1.1.1"],
  "dns-search": ["."]
}
JSON

echo "daemon.json written:"
cat /etc/docker/daemon.json

echo ""
echo "=== Step 3: Restart Docker ==="
sudo systemctl restart docker
sleep 3
echo "Docker restarted"

echo ""
echo "=== Step 4: Verify DNS works inside a container ==="
docker run --rm alpine nslookup files.pythonhosted.org && \
  echo "DNS OK — you can now run docker compose build" || \
  echo "DNS still failing — see manual steps below"

echo ""
echo "=== Step 5 (if still failing): Check host DNS ==="
cat /etc/resolv.conf