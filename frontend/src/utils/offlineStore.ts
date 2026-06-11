/**
 * IndexedDB store for the offline field companion.
 *
 * Two object stores:
 *   projects — cached project feature sets, keyed by project id
 *   outbox   — features created offline, waiting to sync to the server
 */

const DB_NAME = 'rakshagis-field'
const DB_VERSION = 1

export interface CachedProject {
  id: number
  name: string
  project_number: string
  cached_at: string
  features: any[]          // GISFeature records (geometry as GeoJSON)
}

export interface OutboxFeature {
  outbox_id: string        // local uuid
  created_at: string
  payload: {
    project: number
    layer_name: string
    geometry_type: 'POINT'
    geometry: { type: 'Point'; coordinates: [number, number] }
    attributes: Record<string, string>
    feature_id?: string
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'outbox_id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(store: string, mode: IDBTransactionMode,
               fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const r = fn(t.objectStore(store))
    r.onsuccess = () => resolve(r.result as T)
    r.onerror = () => reject(r.error)
    t.oncomplete = () => db.close()
  }))
}

// ── cached projects ──────────────────────────────────────────────────────────

export function cacheProject(p: CachedProject): Promise<unknown> {
  return tx('projects', 'readwrite', s => s.put(p))
}

export function getCachedProject(id: number): Promise<CachedProject | undefined> {
  return tx('projects', 'readonly', s => s.get(id))
}

export function listCachedProjects(): Promise<CachedProject[]> {
  return tx('projects', 'readonly', s => s.getAll())
}

export function removeCachedProject(id: number): Promise<unknown> {
  return tx('projects', 'readwrite', s => s.delete(id))
}

// ── offline outbox ───────────────────────────────────────────────────────────

export function queueFeature(f: OutboxFeature): Promise<unknown> {
  return tx('outbox', 'readwrite', s => s.put(f))
}

export function getOutbox(): Promise<OutboxFeature[]> {
  return tx('outbox', 'readonly', s => s.getAll())
}

export function removeFromOutbox(outboxId: string): Promise<unknown> {
  return tx('outbox', 'readwrite', s => s.delete(outboxId))
}
