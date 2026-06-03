# Cesium Import Fix for TerrainPage

## Issue
When navigating to the 3D Terrain page, the browser console showed:
```
ReferenceError: Cesium is not defined
```

## Root Cause
The TerrainPage component uses a lazy import via React Router (`lazy(() => import('@/features/terrain/TerrainPage'))`). When the component is dynamically loaded, the Cesium library import might not be properly initialized before the component tries to use it.

This happens because:
1. Cesium is imported as `import * as Cesium from 'cesium'` at the module level
2. The component is dynamically loaded (lazy import)
3. Module-level Cesium usage (e.g., `Cesium.Rectangle.fromDegrees()`) happens before Cesium is ready
4. vite-plugin-cesium might not properly export the Cesium global in all cases

## Solution
Made the following changes to `frontend/src/features/terrain/TerrainPage.tsx`:

### 1. Renamed the import to avoid conflicts
```typescript
import * as CesiumLib from 'cesium'
const Cesium = CesiumLib  // Explicit assignment for safety
```

### 2. Wrapped module-level Cesium usage in a function
Changed from:
```typescript
const INDIA_RECT = Cesium.Rectangle.fromDegrees(68.0, 6.5, 97.5, 37.5)
```

To:
```typescript
function getIndiaRect() {
  return Cesium.Rectangle.fromDegrees(68.0, 6.5, 97.5, 37.5)
}
```

This ensures Rectangle is only created after Cesium is loaded.

### 3. Added Cesium readiness check
In the `useEffect` that initializes the viewer:
```typescript
if (!Cesium || !Cesium.Viewer) {
  const err = 'Cesium library failed to load. Please refresh the page.'
  setCesiumError(err)
  return
}
```

### 4. Added error state and user feedback
- Added `cesiumError` state to track load failures
- Added early return with error Alert if Cesium fails to load
- User sees a helpful error message instead of a blank page

## Testing
After this fix:
1. Navigate to the 3D Terrain menu item
2. Page should load without errors
3. You should see the Cesium viewer with India in view
4. All terrain tools (elevation, profile, slope) should work

If Cesium still doesn't load:
1. Check browser console for detailed errors
2. Ensure node_modules has cesium: `ls -la frontend/node_modules/cesium`
3. Rebuild: `npm install` in the frontend directory
4. Clear browser cache and reload

## Files Modified
- `frontend/src/features/terrain/TerrainPage.tsx` — Enhanced Cesium import handling and error detection
- `frontend/vite.config.ts` — Added comment about Cesium plugin configuration

## Technical Notes

### Why this approach?
- **Safety**: By checking `Cesium` exists before using it, we avoid hard-to-debug module loading issues
- **User feedback**: Users get a clear error message if something goes wrong
- **Compatibility**: Works with both ES module imports and vite-plugin-cesium's handling
- **Minimal changes**: Doesn't require restructuring the component significantly

### About vite-plugin-cesium
vite-plugin-cesium handles:
- Building Cesium's large library efficiently
- Setting up Web Worker paths for Cesium
- Configuring module exports

The fix ensures our code is defensive against timing issues in module loading.

## Related Cesium Versions
- cesium: ^1.141.0
- vite-plugin-cesium: ^1.2.23

These versions are compatible, but the plugin occasionally has issues with lazy-loaded components. This fix makes the component more robust.
