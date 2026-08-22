const APP_VERSION = "v1.9.5"; // build:version
const CACHE_PREFIX = "snapcanvas-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;
const META_CACHE = "snapcanvas-update-meta";
const SELECTED_KEY = "./__selected_shell__";
const PRECACHE = [
  "./.nojekyll",
  "./assets/pages-BhIu1aX4.js",
  "./assets/pages-DCP3vrPJ.css",
  "./favicon.svg",
  "./icons/app-icon.svg",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./index.html",
  "./manifest.webmanifest",
  "./version.json"
]; // build:precache

async function shellCaches() {
  return (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX));
}

async function selectedCacheName() {
  const metadata = await caches.open(META_CACHE);
  const response = await metadata.match(SELECTED_KEY);
  const selected = response ? await response.text() : CACHE_NAME;
  return (await caches.has(selected)) ? selected : CACHE_NAME;
}

async function selectCache(name) {
  if (!(await caches.has(name))) return false;
  const metadata = await caches.open(META_CACHE);
  await metadata.put(SELECTED_KEY, new Response(name));
  return true;
}

async function previousCacheName() {
  const selected = await selectedCacheName();
  const names = await shellCaches();
  return names.slice().reverse().find((name) => name !== selected) ?? null;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is atomic from the update flow's point of view: a failed install
    // never replaces the currently active worker or selected stable cache.
    await cache.addAll(PRECACHE);
    // Once every required file is safely cached, activate the complete release
    // without leaving iPad users on an older waiting worker.
    await self.skipWaiting();
  })());
});

self.addEventListener("message", (event) => {
  const reply = (payload) => event.ports?.[0]?.postMessage(payload);
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type === "GET_UPDATE_STATE") {
    event.waitUntil((async () => {
      reply({ current: CACHE_NAME, selected: await selectedCacheName(), rollbackAvailable: Boolean(await previousCacheName()) });
    })());
    return;
  }
  if (event.data?.type === "ROLLBACK") {
    event.waitUntil((async () => {
      const previous = await previousCacheName();
      reply({ ok: previous ? await selectCache(previous) : false, selected: previous });
    })());
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const existing = (await shellCaches()).filter((name) => name !== CACHE_NAME).slice().reverse();
    const upgraded = existing.length > 0;
    const keep = new Set([CACHE_NAME, ...existing.slice(0, 1)]);
    await Promise.all((await shellCaches()).filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
    await selectCache(CACHE_NAME);
    await self.clients.claim();
    if (upgraded) {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(windows.map((client) => {
        const url = new URL(client.url);
        url.searchParams.set("updated", APP_VERSION);
        return client.navigate(url.href).catch(() => null);
      }));
    }
  })());
});

async function cachedIndex(cacheName) {
  const cache = await caches.open(cacheName);
  return (await cache.match("./index.html")) ?? (await cache.match("./"));
}

async function navigationResponse(request, forceRollback) {
  let selected = await selectedCacheName();
  if (forceRollback) {
    const previous = await previousCacheName();
    if (previous && await selectCache(previous)) selected = previous;
  }
  if (selected !== CACHE_NAME) return (await cachedIndex(selected)) ?? Response.error();
  const cache = await caches.open(selected);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) await cache.put("./index.html", response.clone());
    return response;
  } catch {
    return (await cachedIndex(selected)) ?? Response.error();
  }
}

async function assetResponse(request) {
  const selected = await selectedCacheName();
  const cache = await caches.open(selected);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(new Response("External requests are disabled", { status: 403 }));
    return;
  }
  if (request.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    event.respondWith(navigationResponse(request, url.searchParams.has("rollback")));
    return;
  }
  event.respondWith(assetResponse(request).catch(() => Response.error()));
});
