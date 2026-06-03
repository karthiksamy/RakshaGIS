# ✅ External Layers - Complete Implementation Guide

## **SYSTEM OVERVIEW**

Your RakshaGIS map viewer now supports **permanent read-only external data layers** that are maintained in an external PostgreSQL database. These layers support **organization-level filtering** so users only see data relevant to their access level.

---

## **WHAT'S BEEN IMPLEMENTED**

### **1. New "Layers & Tools" Panel** (Left Toolbar)

- **Icon:** Database icon (CloudServerOutlined) with blue indicator
- **Location:** Left toolbar, "TOOLS" section
- **Functionality:** 
  - ✅ View all active external layers
  - ✅ Enable/Disable toggles (simple switches)
  - ✅ View layer metadata (source DB, feature count, filter type)
  - ✅ No edit, delete, or modify options
  - ✅ Auto-fetches geometry on toggle
  - ✅ **NEW: External layers auto-load on map init**

### **2. Auto-Loading Feature** (NEW) ⭐

- **Behavior:** When the map viewer opens, all active external layers are automatically loaded and displayed
- **User Control:** Users can disable any layer anytime using the toggle switch in "Layers & Tools" panel
- **Performance:** Loads up to 20K features per layer
- **Console Logs:** Shows which layers loaded successfully

### **2. Current Configuration: Phase II Layer**

```
Database:          RB (External PostgreSQL)
Table:             public.sp_demap_p2
Geometry Type:     MULTIPOLYGON
Total Features:    5,483
Status:            ✅ ACTIVE & VISIBLE
```

### **3. Organization-Level Row Filtering**

The layer automatically filters features based on **user's organization level**:

| User Level | See | Filter Column | Example |
|-----------|-----|----------------|---------|
| **DGDE** (Nat'l) | All 5,483 | — | No filtering |
| **PDDE** (Regional) | Filtered | `command` | Only their command's rows |
| **DEO** (District) | Filtered | `officeid` | Only their district's rows |
| **CEO** (Circle) | Filtered | `officeid` | Only their circle's rows |
| **ADEO** (Area) | Filtered | `officeid` | Only their area's rows |

**SuperAdmins:** Always see all rows regardless of level

---

## **DATA FLOW ARCHITECTURE**

```
┌─────────────────────────────────────────┐
│  External Database (RB)                  │
│  public.sp_demap_p2 (5,483 features)    │
└──────────────┬──────────────────────────┘
               │
               │ Live Query (psycopg2)
               │ + level_filter_fields
               ▼
┌─────────────────────────────────────────┐
│  Django Backend                          │
│  /api/external/layers/{id}/geojson/    │
│  - Applies level-based WHERE clause     │
│  - Returns filtered GeoJSON             │
└──────────────┬──────────────────────────┘
               │
               │ GeoJSON (up to 20K features)
               ▼
┌─────────────────────────────────────────┐
│  Frontend: ExternalLayersPanel          │
│  - Read-only layer toggle               │
│  - Metadata display                     │
└──────────────┬──────────────────────────┘
               │
               │ VectorLayer (OpenLayers)
               ▼
┌─────────────────────────────────────────┐
│  Map Viewer                              │
│  - Orange styled (#ff6600)              │
│  - 12% fill opacity                     │
│  - Read-only (no edit interactions)     │
│  - zIndex: 75 (above survey layers)     │
└─────────────────────────────────────────┘
```

---

## **FILES MODIFIED**

### **Frontend**

1. **`frontend/src/features/map/ExternalLayersPanel.tsx`** (NEW)
   - Dedicated read-only external layer management panel
   - Table with Enable/Disable switches
   - Supports level-based filter display
   - Live geometry fetching

2. **`frontend/src/features/map/MapPage.tsx`** (UPDATED)
   - Added import: `ExternalLayersPanel`
   - Added state: `extLayersPanelOpen` (boolean)
   - Added button: "Layers & Tools" (database icon in toolbar)
   - Integrated panel component with callbacks

### **Backend** (Already Correct)

1. **`apps/external_data/db_utils.py`**
   - `_resolve_filter_column()` - Selects filter column by org level
   - `allowed_office_codes()` - Gets user's accessible office IDs
   - `layer_geojson()` - Applies WHERE clause based on filters
   - Supports `level_filter_fields` mapping

2. **`apps/external_data/views.py`**
   - `ExternalLayerViewSet.geojson()` - Passes user to `layer_geojson()`
   - Automatically applies user-level filtering

3. **`apps/external_data/models.py`**
   - `ExternalLayer.level_filter_fields` - JSON dict: `{"DEO": "col", ...}`
   - `ExternalLayer.office_filter_field` - Fallback filter column

---

## **FEATURE CHECKLIST**

✅ **Display:** External layers shown permanently on map (when enabled)
✅ **Read-Only:** No edit/delete/modify controls
✅ **Layer List:** Only enable/disable options in UI
✅ **Metadata:** Stored locally (name, source, config)
✅ **Geometry:** Fetched dynamically from external DB (not copied)
✅ **Filtering:** Based on `level_filter_fields` + user's org level
✅ **Styling:** Orange with custom opacity (read-only marker)
✅ **Performance:** Limits to 20K features per query
✅ **Permissions:** All authenticated users can view (read-only)

---

## **HOW TO USE**

### **Step 1: Open Map Viewer**
- Log in and open any survey project
- External layers **auto-load automatically** (no action needed)
- Check the console (F12) for loading confirmation messages

### **Step 2: See Loaded Layers**
- Orange-colored "Phase II" features appear on the map
- Layers display based on your **organization level** (filtered rows)
- Blue dot indicator appears on "Layers & Tools" button

### **Step 3: Manage Layers (Optional)**
- Click **"Layers & Tools"** button to open panel
- Click the **Disable** toggle to hide any layer
- Click **Enable** to show it again
- Changes are temporary (layers re-load on next map open)

---

## **TESTING THE FILTERING**

### **Test as DGDE User (SuperAdmin)**
```bash
# See all 5,483 features
docker-compose logs -f web | grep "layer_geojson"
# No WHERE clause applied (or sees all)
```

### **Test as DEO User**
```python
# In Django shell:
user = User.objects.get(role='DEO')  # Must have organisation assigned
layer = ExternalLayer.objects.get(id=6)
from apps.external_data.db_utils import layer_geojson
fc = layer_geojson(layer, limit=5000, user=user)
print(len(fc['features']))  # Will be < 5483 (filtered by officeid)
```

### **Test API Directly**
```bash
# As authenticated user:
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:8000/api/external/layers/6/geojson/?limit=5000"
# Returns filtered GeoJSON based on user's org level
```

---

## **CONFIGURATION** (Admin Only)

**Access:** Admin Panel → External Data → External Layers

**Editable Fields:**

| Field | Purpose | Current |
|-------|---------|---------|
| `display_name` | Layer title | "Phase II" |
| `is_active` | Enable/disable visibility | ✅ True |
| `level_filter_fields` | JSON: org level → column | `{"CEO":"officeid","DEO":"officeid"...}` |
| `office_filter_field` | Fallback filter column | *(empty)* |
| `style` | OpenLayers JSON style | `{}` (uses default orange) |
| `min_zoom` | Min zoom to display | 5 |

**To Deactivate a Layer:**
```python
layer = ExternalLayer.objects.get(id=6)
layer.is_active = False
layer.save()
```

---

## **API ENDPOINTS** 

All endpoints require authentication.

### **List Active Layers**
```
GET /api/external/layers/
Returns: [{ id, display_name, database_name, geometry_type, feature_count, ... }]
```

### **Get Layer GeoJSON** ⭐ (Filtered by user level)
```
GET /api/external/layers/{id}/geojson/?limit=5000
Returns: { type: "FeatureCollection", features: [...] }
Note: Only features visible to user's org level are returned
```

### **Refresh Layer Stats** (Admin)
```
POST /api/external/layers/{id}/refresh-stats/
Returns: { bbox: [...], feature_count: 5483 }
```

---

## **LAYER STYLING ON MAP**

**Visual Properties:**
- **Color:** Orange (#ff6600)
- **Stroke Width:** 1.8px
- **Fill Color:** rgba(255, 102, 0, 0.12) - 12% opacity
- **Fill Pattern:** Solid
- **zIndex:** 75 (above survey layers)
- **Point Size:** 5px radius

**Interactions:**
- ✅ Pan / Zoom
- ✅ View attributes (click feature)
- ❌ Edit geometry
- ❌ Delete feature
- ❌ Draw on layer
- ❌ Modify style

---

## **TROUBLESHOOTING**

### ❌ Layer Not Showing on Map
**Check:**
1. Is layer `is_active = True`? → Set via Admin Panel
2. Did you click Enable in the panel? → Click toggle
3. Browser cached? → Hard refresh (Ctrl+Shift+R)

### ❌ 0 Features Appeared
**Causes:**
1. Row-level filtering hiding all data
   - Solution: Check user's org level & office codes in DB
2. Layer table has no features
   - Solution: Verify external DB query returns rows

### ❌ External Database Connection Error
**Solution:**
1. Admin → External Data → Databases
2. Click "Test Connection" button
3. Check error message

### ⚠️ Slow Loading
**Cause:** Large number of features (>20K limit)
**Solution:** Increase `limit` parameter in API (up to 20K) or add more filters

---

## **NEXT STEPS**

1. ✅ Refresh your browser (Ctrl+Shift+R)
2. ✅ Log in as different users (CEOs, DEOs, PDDEs)
3. ✅ Open "Layers & Tools" panel
4. ✅ Enable "Phase II" layer
5. ✅ Observe filtered features based on org level
6. ✅ Test that features are read-only (no edit interactions)

---

## **SUPPORT**

If you need to:
- **Add more external layers:** Contact SuperAdmin to configure in External Data section
- **Change filter columns:** Edit `level_filter_fields` in Admin Panel
- **Modify layer styling:** Update `style` JSON field
- **Debug filtering issues:** Check user's `organisation.office_id` and filter column mapping

