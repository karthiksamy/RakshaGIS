# External Layers - Admin Configuration Guide

## **Quick Reference for Administrators**

### **Add a New External Layer**

**Steps:**

1. **Access Admin Panel**
   - Admin URL: `/admin/external_data/externallayer/`
   - Must be SuperAdmin

2. **Add New External Layer**
   - Click "ADD EXTERNAL LAYER" button

3. **Fill Required Fields**

   | Field | Description | Example |
   |-------|-------------|---------|
   | **Database** | Select external DB | "RB" |
   | **Schema Name** | Database schema | "public" |
   | **Table Name** | Table in external DB | "sp_demap_p2" |
   | **Display Name** | User-facing name | "Phase II Survey" |
   | **Geometry Column** | Name of geom column | "geom" |
   | **Geometry Type** | Type of geometries | "MULTIPOLYGON" |
   | **SRID** | Spatial reference ID | 4326 |
   | **ID Column** | Primary key column | "gid" |
   | **Is Active** | Enable on map | ✅ True |

4. **Configure Row-Level Filtering** (Optional)

   **Option A: Level-Based Filter** (Recommended)
   - `level_filter_fields`: JSON dictionary mapping org levels to column names
   
   ```json
   {
     "PDDE": "command",
     "DEO": "officeid",
     "CEO": "officeid",
     "ADEO": "officeid"
   }
   ```
   
   **Option B: Single Column Filter** (Legacy)
   - `office_filter_field`: Single column name for all users
   ```
   "officeid"
   ```

5. **Save and Test**
   - Click "SAVE"
   - Refresh stats via "refresh-stats" endpoint
   - Verify in map viewer

---

## **Example: Adding a New External Layer**

### **Scenario:** Add Fire Department Stations

**Config:**

```
Database:           RB
Schema:             public
Table:              fire_stations
Display Name:       Fire Department Stations
Geometry Type:      POINT
SRID:               4326
Geometry Column:    geom
ID Column:          station_id
Label Column:       station_name

Level Filter Fields:
{
  "PDDE": "state_code",
  "DEO": "district_code",
  "CEO": "zone_code",
  "ADEO": "area_code"
}

Is Active:          ✅ TRUE
Min Zoom:           5
```

**Result:**
- PDDE users see fire stations in their state
- DEO users see fire stations in their district
- CEO/ADEO users see fire stations in their zone/area
- Geometry NOT stored in RakshaGIS (stays in RB database)

---

## **Managing Existing Layers**

### **Activate/Deactivate Layer**

**Via Admin:**
1. Admin → External Layers
2. Find layer in list
3. Edit `is_active` field
4. Save

**Via Django Shell:**
```python
from apps.external_data.models import ExternalLayer
layer = ExternalLayer.objects.get(id=6)
layer.is_active = True  # or False
layer.save()
```

### **Refresh Layer Statistics**

```bash
# Updates feature_count and bbox from external DB
POST /api/external/layers/{id}/refresh-stats/
```

**Via Django:**
```python
from apps.external_data.db_utils import layer_bbox_and_count
bbox, count = layer_bbox_and_count(layer)
layer.bbox = bbox
layer.feature_count = count
layer.save()
```

### **Change Filter Configuration**

**Via Admin:**
1. Edit layer
2. Update `level_filter_fields` JSON
3. Save

**Example:** Change filter from `officeid` to `zone_id`

```json
Before:
{
  "DEO": "officeid",
  "CEO": "officeid"
}

After:
{
  "DEO": "zone_id",
  "CEO": "zone_id"
}
```

---

## **Database Connection Management**

### **Add External Database**

**Steps:**

1. Admin → External Databases → Add
2. Fill connection details:
   - **Name:** Friendly name (e.g., "DGDE Operational DB")
   - **Host:** Database hostname
   - **Port:** PostgreSQL port (default: 5432)
   - **Database:** Database name
   - **Schema:** Default schema (usually "public")
   - **Username:** DB user
   - **Password:** DB password

3. **Test Connection**
   - Click "TEST" button
   - Should see PostgreSQL version if successful

### **View Spatial Tables**

```bash
# List all spatial tables in external DB
GET /api/external/databases/{id}/tables/

# Returns:
[
  {
    "schema": "public",
    "table": "sp_demap_p2",
    "geom_column": "geom",
    "geom_type": "MULTIPOLYGON",
    "srid": 4326,
    "row_count": 5483
  },
  ...
]
```

---

## **Troubleshooting External Layers**

### **Problem: Layer shows 0 features**

**Check List:**
1. Is `is_active = True`?
2. Is external database connection OK?
3. Are users' organisation levels set correctly?
4. Are filter column names correct in `level_filter_fields`?
5. Do filter columns exist in the external table?

**Debug:**
```python
from apps.external_data.db_utils import layer_geojson
from apps.accounts.models import User

user = User.objects.get(username='test_user')
layer = ExternalLayer.objects.get(id=6)
fc = layer_geojson(layer, limit=5000, user=user)

print(f"Features for {user}: {len(fc['features'])}")
print(f"User org level: {user.organisation.level}")
print(f"User office codes: {user.organisation.office_id}")
```

### **Problem: Connection fails**

**Steps:**
1. Verify host/port/database name are correct
2. Check PostgreSQL server is running
3. Verify credentials
4. Test from docker container:
   ```bash
   docker-compose exec web psql -h RB_HOST -U USERNAME -d DATABASE
   ```

### **Problem: Wrong filter column**

**Verify:**
1. Check external table structure:
   ```sql
   SELECT column_name, data_type 
   FROM information_schema.columns 
   WHERE table_name = 'sp_demap_p2'
   ```

2. Check data type (should be TEXT or CHAR):
   ```sql
   SELECT DISTINCT officeid FROM public.sp_demap_p2 LIMIT 10;
   ```

3. Update `level_filter_fields` with correct column name

---

## **Performance Tuning**

### **Large Layers (>20K features)**

**Options:**
1. Increase `limit` parameter (up to 20K):
   ```
   /api/external/layers/{id}/geojson/?limit=20000
   ```

2. Add filter columns to speed up filtering:
   ```sql
   CREATE INDEX idx_sp_demap_officeid ON public.sp_demap_p2(officeid);
   CREATE INDEX idx_sp_demap_geom ON public.sp_demap_p2 USING GIST(geom);
   ```

3. Use tiling for very large layers (advanced)

### **Slow Queries**

**Profile:**
```python
import time
start = time.time()
fc = layer_geojson(layer, limit=5000, user=user)
print(f"Query took: {time.time() - start:.2f}s")
```

**Optimize:**
- Add indexes on filter columns
- Add spatial index on geometry column
- Verify network latency to external DB

---

## **Security Considerations**

### **Sensitive Data**

⚠️ **CRITICAL:** External database credentials stored in `ExternalDatabase.password` (plain text)

**Recommendations:**
1. Restrict access to Admin interface (SuperAdmin only)
2. Use read-only database user for external connections
3. Use network security (firewall rules, VPN)
4. Consider using Django's cipher fields for password encryption

### **Row-Level Security**

✅ **Implemented:** Users only see rows matching their org level

**How it works:**
1. User logs in with specific `organisation` and `level`
2. Frontend requests layer GeoJSON
3. Backend looks up user's org level in `level_filter_fields`
4. SQL WHERE clause restricts rows to user's office code
5. Only matching features returned

**Bypass:** Only SuperAdmins can see all rows

---

## **Monitoring & Logging**

### **Check Layer Status**

```python
from apps.external_data.models import ExternalLayer

for layer in ExternalLayer.objects.all():
    db = layer.database
    print(f"{layer.display_name}:")
    print(f"  Active: {layer.is_active}")
    print(f"  DB Status: {db.test_status}")
    print(f"  Features: {layer.feature_count}")
    print(f"  Last Synced: {layer.last_synced_at}")
```

### **View Logs**

```bash
# Backend logs
docker-compose logs -f web | grep -i "layer_geojson\|external"

# Check for errors
docker-compose logs web | grep -i "error"
```

### **Database Queries**

**Enable query logging (development only):**
```python
# In settings.py
LOGGING = {
    'version': 1,
    'handlers': {
        'console': {'class': 'logging.StreamHandler'},
    },
    'loggers': {
        'apps.external_data': {
            'handlers': ['console'],
            'level': 'DEBUG',
        },
    },
}
```

---

## **Useful Commands**

```bash
# Activate all external layers
docker-compose exec -T web python manage.py shell << 'EOF'
from apps.external_data.models import ExternalLayer
ExternalLayer.objects.all().update(is_active=True)
EOF

# List all active external layers
docker-compose exec -T web python manage.py shell << 'EOF'
from apps.external_data.models import ExternalLayer
for layer in ExternalLayer.objects.filter(is_active=True):
    print(f"{layer.id}: {layer.display_name} ({layer.feature_count} features)")
EOF

# Test layer_geojson function
docker-compose exec -T web python manage.py shell << 'EOF'
from apps.external_data.models import ExternalLayer
from apps.external_data.db_utils import layer_geojson
layer = ExternalLayer.objects.get(id=6)
fc = layer_geojson(layer, limit=5000, user=None)
print(f"Total features: {len(fc['features'])}")
EOF
```

---

## **Support & Questions**

- Check `EXTERNAL_LAYERS_IMPLEMENTATION.md` for user guide
- Review `apps/external_data/` for source code
- Check Django logs: `docker-compose logs web`
