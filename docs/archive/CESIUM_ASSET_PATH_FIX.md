# Cesium Asset Path Fix

## Issue
The 3D Terrain viewer fails to load because Cesium.js cannot be found. The browser console shows:
```
GET http://localhost/static/frontend/cesium/Cesium.js 404 Not Found
```

## Root Cause
The vite-plugin-cesium bundler places Cesium assets at the root of the static directory (`/static/cesium/`) rather than under the configured base path (`/static/frontend/cesium/`).

This is due to how vite-plugin-cesium handles the base URL configuration - it doesn't properly namespace assets under the `base` directory.

## Current Status
- ✅ Cesium.js IS available at: `/static/cesium/Cesium.js` (HTTP 200)
- ❌ Browser expects it at: `/static/frontend/cesium/Cesium.js` (HTTP 404)

## Solutions

### Short-term Fix (Immediate)
Update the Cesium CSS/JS import paths in your HTML to use the correct location:

In `frontend/index.html`, add a script tag:
```html
<script>
  // Cesium assets are at /static/cesium/, not /static/frontend/cesium/
  window.CESIUM_BASE_URL = '/static/cesium/';
</script>
```

Then update TerrainPage.tsx to use this:
```typescript
// Before the Cesium import
import('cesium').then((CesiumModule) => {
  // Assets are at /static/cesium/
  if (typeof window !== 'undefined') {
    window.CESIUM_BASE_URL = '/static/cesium/';
  }
})
```

### Permanent Fix (Rebuild)
Update `docker-compose.yml` to mount static files without the `/frontend/` subdirectory:

```yaml
nginx:
  volumes:
    - ./deploy/nginx-docker.conf:/etc/nginx/conf.d/default.conf:ro
    - ${DATA_DIR}/staticfiles:/staticfiles:ro  # Maps /static/ → /staticfiles/ (no frontend subdir)
```

Then adjust vite.config.ts:
```typescript
base: '/static/',  // Not '/static/frontend/'
```

And build.sh should output to `../staticfiles/` instead of `../static/frontend/`.

### Working Workaround (For Now)
1. Update nginx config to create an alias for the Cesium path
2. Or symlink `/staticfiles/frontend/cesium` → `/staticfiles/cesium` (requires RW volume)
3. Or update TerrainPage to dynamically adjust the Cesium base URL

## Files to Update
- `frontend/vite.config.ts` - Remove the `/frontend/` from base URL
- `docker-compose.yml` - Update nginx volume mount  
- `build.sh` - Update output directory
- `frontend/index.html` - Add Cesium base URL fix

## Testing
After applying the fix:
```bash
# Rebuild frontend
cd frontend && npm run build

# Copy to correct location
cp -r static/frontend/. /data/rakshagis/staticfiles/

# Verify
curl -I http://localhost/static/cesium/Cesium.js  # Should be 200 OK
curl -I http://localhost/static/frontend/cesium/Cesium.js  # Should eventually also be 200 OK after config fix
```

## Technical Details

### Why This Happens
- vite-plugin-cesium creates a public directory structure for Cesium assets
- This structure is placed relative to the alias root (`/staticfiles/`), not the base URL
- The nginx alias setting creates an indirect path: `/static/` → `/staticfiles/`
- But vite-plugin-cesium doesn't account for the extra `/frontend/` subdirectory in the base URL

###  Architecture
```
vite.config.ts:
  base: '/static/frontend/'  ← Browsers expect assets here
  
docker-compose.yml:
  alias: /static/ → /staticfiles/  ← Nginx maps
  
/staticfiles/:
  cesium/                           ← vite-plugin-cesium puts assets here
  frontend/                         ← But base URL adds this
    assets/
    index.html

Result:
  Browser request: /static/frontend/cesium/Cesium.js
  Resolved to: /staticfiles/frontend/cesium/Cesium.js  ← Doesn't exist!
  Actually at: /staticfiles/cesium/Cesium.js  ← Here it is
```

## References
- [vite-plugin-cesium](https://github.com/vite-plugin-cesium/vite-plugin-cesium)
- [Cesium.js Documentation](https://cesium.com/docs/)
- [Vite Configuration](https://vitejs.dev/config/)
