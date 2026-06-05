const DB_NAME = 'rakshagis-offline';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as any).result as IDBDatabase;
      if (!db.objectStoreNames.contains('cached_features')) {
        db.createObjectStore('cached_features', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('offline_queue')) {
        db.createObjectStore('offline_queue', { keyPath: 'offline_id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('cached_metadata')) {
        db.createObjectStore('cached_metadata', { keyPath: 'key' });
      }
    };
    
    request.onsuccess = (event) => {
      resolve((event.target as any).result as IDBDatabase);
    };
    
    request.onerror = (event) => {
      reject((event.target as any).error);
    };
  });
  
  return dbPromise;
}

export async function saveCachedFeatures(features: any[]): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cached_features', 'readwrite');
    const store = tx.objectStore('cached_features');
    
    features.forEach(f => {
      store.put(f);
    });
    
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedFeatures(projectId: number): Promise<any[]> {
  const db = await getDb();
  return new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction('cached_features', 'readonly');
    const store = tx.objectStore('cached_features');
    const request = store.getAll();
    
    request.onsuccess = () => {
      const results = request.result || [];
      resolve(results.filter((f: any) => f.project === projectId));
    };
    
    request.onerror = () => reject(request.error);
  });
}

export async function clearCachedFeatures(projectId: number): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cached_features', 'readwrite');
    const store = tx.objectStore('cached_features');
    const request = store.openCursor();
    
    request.onsuccess = (event) => {
      const cursor = (event.target as any).result;
      if (cursor) {
        if (cursor.value.project === projectId) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    
    request.onerror = () => reject(request.error);
  });
}

export async function queueOfflineFeature(feature: any): Promise<number> {
  const db = await getDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction('offline_queue', 'readwrite');
    const store = tx.objectStore('offline_queue');
    const request = store.add(feature);
    
    request.onsuccess = () => resolve(request.result as number);
    request.onerror = () => reject(request.error);
  });
}

export async function getOfflineQueue(): Promise<any[]> {
  const db = await getDb();
  return new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction('offline_queue', 'readonly');
    const store = tx.objectStore('offline_queue');
    const request = store.getAll();
    
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function clearOfflineQueueItem(offlineId: number): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('offline_queue', 'readwrite');
    const store = tx.objectStore('offline_queue');
    const request = store.delete(offlineId);
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function saveMetadata(key: string, value: any): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cached_metadata', 'readwrite');
    const store = tx.objectStore('cached_metadata');
    const request = store.put({ key, value });
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getMetadata(key: string): Promise<any> {
  const db = await getDb();
  return new Promise<any>((resolve, reject) => {
    const tx = db.transaction('cached_metadata', 'readonly');
    const store = tx.objectStore('cached_metadata');
    const request = store.get(key);
    
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => reject(request.error);
  });
}
