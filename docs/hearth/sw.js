/*
 * Hearth service worker — the update path.
 *
 * ## Why this file exists
 *
 * An iOS home-screen web app with **no service worker** holds a frozen copy of
 * the page it was installed from. On 2026-08-17 three client fixes shipped in
 * ninety minutes and the installed app received none of them: it kept running
 * the first build, offering to pair on every launch, while the desktop log
 * showed the same already-trusted device id pairing four times in five
 * minutes. Versioning the script reference inside the HTML (`main.js?v=4`) did
 * nothing, because the HTML is itself what was cached.
 *
 * An installed app that can never receive a fix is a shipping blocker. This
 * worker is the mechanism by which an update can arrive at all.
 *
 * ## Strategy, and why it is split
 *
 * - **App shell (`index.html`, `main.js`, `manifest`, icons): network-first.**
 *   The cache is an *offline fallback*, never a performance optimisation. If
 *   the network answers, its answer wins — full stop. Stale code is the bug
 *   this file exists to prevent, so the shell never gets to serve stale bytes
 *   while the network is reachable.
 * - **Wasm (~2.9 MB, changes rarely): cache-first, keyed on VERSION.** Paying
 *   3 MB on every launch to re-fetch a module that changes once a week is
 *   indefensible on a phone. Correctness comes from the key instead: a new
 *   build means a new cache name means an empty cache means a fresh fetch.
 *   There is no revalidation to get wrong.
 * - **`skipWaiting` + `clients.claim`.** The default lifecycle parks a new
 *   worker until every tab closes. Installed home-screen apps are rarely
 *   "closed" in the way that requires, which is how a fix waits forever.
 * - **The page is told.** A silent swap is how you get bug reports about
 *   behaviour nobody shipped, so main.js renders a plain "Hearth updated —
 *   reload" notice on `controllerchange`.
 *
 * VERSION is stamped by scripts/set-client-version.sh alongside web/main.js
 * and src/version.rs. Bumping it invalidates both caches.
 */
const VERSION = "0.3.0";
const SHELL_CACHE = `hearth-shell-${VERSION}`;
const WASM_CACHE = `hearth-wasm-${VERSION}`;

/* The shell, precached at install so a freshly activated worker can already
 * open the app offline. Without this there is a window — from "new worker
 * activated and deleted the old caches" until "the app has been opened once
 * more online" — where the app would not start offline. It is a few KB.
 *
 * The wasm is deliberately NOT in here: it is 2.9 MB, and it is already being
 * fetched by the page on the very load that triggered this install. Precaching
 * it would download it twice. The cost is that offline start is unavailable
 * for the one load after an update, which is a much smaller failure than
 * doubling every update's bandwidth on a phone. */
const SHELL = [
  "./",
  "./index.html",
  "./main.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, and tolerantly: one missing icon must not abort the
      // install and leave the app with no update path at all.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      );
      // Take over as soon as we are installed rather than waiting for every
      // client to close — see the lifecycle note above.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache belonging to another build. This is what makes the
      // wasm's cache-first policy safe: the old module is not evicted by age
      // or revalidation, it is evicted by the version changing.
      const keep = new Set([SHELL_CACHE, WASM_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith("hearth-") && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** The big, rarely-changing build artefact. Everything else is app shell. */
function isWasm(url) {
  return url.pathname.includes("/wasm/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The probe/result hooks are deliberate 404s read out of the dev server's
  // log (see main.js). Caching or replaying them would corrupt a test run.
  if (url.pathname.includes("__hearth_")) return;

  event.respondWith(isWasm(url) ? cacheFirst(request) : networkFirst(request));
});

/**
 * Network-first: the network's answer always wins when there is one, and is
 * written back so the app still opens offline. A cache hit is a fallback and
 * is treated as such — never as the normal path.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

/**
 * Cache-first within this build. A miss fetches and stores; there is no
 * conditional request, because a change of contents is always accompanied by
 * a change of VERSION.
 *
 * Note the absence of `ignoreSearch`: main.js puts the build version in the
 * wasm URL's query precisely so that a new build is a cache *miss* here even
 * when the request is still being handled by the previous worker (the update
 * load is served by the old worker — the new one has not claimed yet). Without
 * this, a new shell would run last build's wasm for one whole load.
 */
async function cacheFirst(request) {
  const cache = await caches.open(WASM_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) await cache.put(request, response.clone());
  return response;
}

/* Lets the page ask which build is actually serving it — used by the update
 * notice and by the headless propagation test. */
self.addEventListener("message", (event) => {
  if (event.data === "version") event.source?.postMessage({ type: "version", version: VERSION });
});
