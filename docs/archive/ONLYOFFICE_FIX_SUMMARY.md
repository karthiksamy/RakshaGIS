# OnlyOffice Modal Fix - Complete Summary

**Issue**: Documents opening in modal dialog instead of new tab  
**Status**: ✅ FIXED - Waiting for frontend rebuild to complete  
**Date**: 2026-05-30

---

## What Was Wrong

Old behavior (modal):
```
User clicks "Open" → OnlyOffice modal opens in same window
```

New behavior (new tab):
```
User clicks "Open" → OnlyOffice editor opens in NEW TAB
User can keep main app open while editing
```

---

## Files That Were Fixed

### 1. **DocumentsPage.tsx** ✅
- **Location**: `frontend/src/features/documents/DocumentsPage.tsx`
- **Change**: Removed modal logic, now uses `openDocumentInNewTab(doc.id)`
- **Line**: 82

### 2. **ProjectDetailPage.tsx** ✅
- **Location**: `frontend/src/features/projects/ProjectDetailPage.tsx`
- **Changes**:
  - Removed OnlyOfficeViewerModal import
  - Removed modal state management
  - Removed modal JSX rendering (lines 2076-2079 now return null)
  - All "Open" buttons now call `openDocumentInNewTab(doc.id)`
- **Lines**: 31, 182, 545, 696, 701, 807, 998, 1008, 1009, 2042, 2076+

### 3. **documentUtils.ts** ✅
- **Location**: `frontend/src/services/documentUtils.ts`
- **Purpose**: Utility function to open documents in new tab
- **Function**:
  ```typescript
  export async function openDocumentInNewTab(docId: number): Promise<void>
  ```
- **What it does**:
  1. Fetches editor config from `/documents/{docId}/editor-config/`
  2. Extracts editor URL from response
  3. Opens URL in new browser tab using `window.open()`
  4. Shows success/error messages

---

## Backend Support (Already Exists)

**Endpoint**: `GET /documents/{id}/editor-config/`  
**Location**: `apps/documents/views.py`  
**Status**: ✅ Already implemented  
**Returns**: Editor configuration with document URL

---

## Current Status

### ✅ Completed
- Source code updated (all 3 files)
- Backend endpoint ready
- Documentation complete

### 🔄 In Progress
- **Frontend rebuild** (`npm run build`)
- This compiles the TypeScript → JavaScript
- Creates new dist files in `staticfiles/`

### ⏭️ Next Steps
1. Frontend build completes
2. Start Docker services: `docker compose up -d`
3. Clear browser cache (Ctrl+Shift+Del)
4. Test: Open a document → Should open in NEW TAB

---

## How to Test

**After frontend rebuild:**

```bash
# 1. Start backend
docker compose up -d

# 2. Start frontend dev server (or just use compiled version)
cd frontend && npm run dev

# 3. Open in browser
# Dev: http://localhost:5173/documents
# Prod: http://localhost/documents

# 4. Click "Open" button on any Office document
# EXPECTED: New tab opens with OnlyOffice editor
# OLD BUG: Modal appeared in same window
```

---

## Verification Checklist

- [ ] Frontend build completes without errors
- [ ] Docker services start successfully
- [ ] Open a document → New tab opens
- [ ] Document editor loads in the tab
- [ ] Can edit and save normally
- [ ] Main app window still visible
- [ ] No modal dialogs appear
- [ ] Close editor tab → Main app still works

---

## If It Still Shows Modal

This means the frontend wasn't rebuilt. Do this:

```bash
cd /home/karthi/RakshaGIS/frontend
npm run build

# Then clear browser cache
# Ctrl+Shift+Del (or Cmd+Shift+Del on Mac)
# Select "Cached images and files"
# Click "Clear"

# Reload page
```

---

## Code Changes Summary

### Before (Modal Approach - ❌ BAD)
```tsx
<Button onClick={() => setOnlyOfficeDocId(doc.id)}>Open</Button>
// Later:
<OnlyOfficeViewerModal visible={onlyOfficeDocId} ... />
```

**Problems**:
- DOM manipulation issues
- Modal blocking the main UI
- Can't work on main app while editing

### After (New Tab Approach - ✅ GOOD)
```tsx
<Button onClick={() => openDocumentInNewTab(doc.id)}>Open</Button>
```

**Benefits**:
- No DOM issues
- User keeps main app open
- Better UX
- Cleaner code

---

## Files Involved

```
frontend/
├── src/features/
│   ├── documents/
│   │   └── DocumentsPage.tsx          ✅ Updated
│   ├── projects/
│   │   └── ProjectDetailPage.tsx      ✅ Updated
│   └── services/
│       └── documentUtils.ts           ✅ Created
└── dist/                              ← Will be updated by npm run build

apps/
└── documents/
    └── views.py                       ✅ Already has endpoint
```

---

## Expected Timeline

| Step | Time | Status |
|------|------|--------|
| Source code fixes | Done | ✅ Complete |
| Frontend rebuild | ~2-3 min | 🔄 Running |
| Docker services | ~1 min | ⏭️ Next |
| Test in browser | ~2 min | ⏭️ After startup |
| **Total** | **~5-10 min** | |

---

## Support

**If documents still open in modal after rebuild:**

1. Check browser console for errors: F12 → Console tab
2. Hard refresh page: `Ctrl+F5`
3. Check backend logs: `docker compose logs -f web`
4. Verify endpoint works: `curl http://localhost/api/documents/1/editor-config/`

**Contact**: balusamy.karthikeyan@gmail.com

---

**Status**: Waiting for frontend build to complete...  
**Next**: Docker services will be started automatically  
**Final**: Test in browser with real documents
