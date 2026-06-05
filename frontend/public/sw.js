const CACHE_NAME = 'rakshagis-v1';
const TILE_CACHE_NAME = 'map-tiles-offline';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        PRECACHE_ASSETS.map((asset) => {
          return cache.add(asset).catch((err) => {
            console.warn(`[ServiceWorker] Failed to cache: ${asset}`, err);
          });
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== TILE_CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // Check if it's a map tile request (OSM, Bhuvan, GeoServer, XYZ)
  const isTile = 
    url.hostname.includes('tile.openstreetmap.org') || 
    url.hostname.includes('bhuvan') || 
    url.pathname.includes('/geoserver/wms') ||
    url.pathname.includes('/tiles/') ||
    url.pathname.includes('/xyz/');

  if (isTile) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            // Background sync tile update if online
            fetch(event.request)
              .then((networkResponse) => {
                if (networkResponse.status === 200) {
                  cache.put(event.request, networkResponse);
                }
              })
              .catch(() => {});
            return cachedResponse;
          }

          return fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse.status === 200) {
                cache.put(event.request, networkResponse.clone());
              }
              return networkResponse;
            })
            .catch(() => {
              // Return offline empty placeholder response
              return new Response('', { status: 404 });
            });
        });
      })
    );
    return;
  }

  // API calls are served network-first
  if (url.pathname.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request) || new Response(JSON.stringify({ detail: "You are currently offline." }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // App shell & static assets (js, css) are cached-first
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse.status === 200) {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, cacheCopy);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Return cached app shell for navigation fallback
        return caches.match('/');
      });
    })
  );
});
