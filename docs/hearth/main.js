/*
 * Hearth phone client logic.
 *
 * Owns: chat rendering and driving the wasm iroh client. It owns NO
 * authoritative state — the desktop's conversation.log.md is the transcript,
 * and this page is a view over it. On every load we fetch the transcript tail
 * from the desktop (HearthClient.history) and render that; a fresh browser on
 * a new device sees the same conversation as every other device.
 *
 * localStorage is kept purely as an offline cache for instant paint, plus the
 * two durable identifiers below: this device's key, and the desktop's address.
 *
 * ## Address vs authorization (the 2026-08-17 rework)
 *
 * The URL fragment carries ONLY the desktop's endpoint id. That is an address:
 * safe to bookmark, cache, install to a home screen and re-launch forever.
 * Authorization is a separate short code the owner reads off the desktop and
 * types here. Putting the two in one string caused three bugs in one
 * afternoon — Safari consuming the single-use secret on load before the user
 * could install; the installed app re-offering to pair on every launch from
 * its saved start URL; and neither fix reaching the installed app at all. See
 * docs/DECISIONS.md #12.
 *
 * Message flow: send() calls HearthClient.send(serverId, text, version), which
 * returns a ReadableStream of progress events from Rust
 * ({type: connected|sent|received|denied|closed}). "received" carries the
 * agent's reply (or an agent-side error, so "the model broke" looks different
 * from "desktop unreachable" — R3.6) and any desktop warning.
 *
 * Test hooks (all harmless in production — they are deliberate 404s the
 * serving http server logs, which is how the headless tests read outcomes):
 *   ?auto=<message>  auto-send once after load  → ./__hearth_result__…
 *   ?probe           report history + client version → ./__hearth_history__…,
 *                    ./__hearth_client__…
 */
/* This build of the app shell. Stamped by scripts/set-client-version.sh
 * together with web/sw.js and src/version.rs — the version is a build
 * artefact, not three numbers to keep in your head. Reported to the desktop on
 * every request so "your client is stale" can be *said* rather than inferred
 * from behaviour nobody shipped. */
const CLIENT_VERSION = "0.4.0";
/* Exposed so "which build is this phone actually running?" is answerable from
 * a console or a remote inspector without reading source. The whole class of
 * bug this file was reworked to fix was invisible precisely because nobody
 * could ask that question. */
window.HEARTH_CLIENT_VERSION = CLIENT_VERSION;

/* The wasm is loaded through a *dynamic* import with the build version in the
 * query, and `init` is handed an equally versioned URL for the binary itself
 * (wasm-bindgen would otherwise derive an unversioned one from import.meta.url).
 * Both are deliberate: the service worker caches wasm cache-first — it is
 * ~2.9 MB and changes rarely — so the only thing that can force a fresh copy is
 * the URL changing. A static `import` cannot carry the version, and a new shell
 * running an old wasm is a signature mismatch waiting to happen. The two halves
 * of a build travel together or the whole update story is a fiction. */
const WASM_JS = new URL(`./wasm/hearth.js?v=${CLIENT_VERSION}`, import.meta.url);
const WASM_BIN = new URL(`./wasm/hearth_bg.wasm?v=${CLIENT_VERSION}`, import.meta.url);
const { default: init, HearthClient } = await import(WASM_JS.href);

const chatEl = document.getElementById("chat");
const statusEl = document.getElementById("status");
const msgEl = document.getElementById("msg");
const sendBtn = document.getElementById("send");
const form = document.getElementById("composer");
const noticeEl = document.getElementById("notice");
const switchBtn = document.getElementById("switch");
const menuEl = document.getElementById("desktops");

const probing = new URLSearchParams(location.search).has("probe");
/** Report to the dev server's log (a deliberate 404). No-op-ish in production. */
function probe(path) {
  if (probing) fetch(path).catch(() => {});
}
probe(`./__hearth_client__version=${CLIENT_VERSION}&controlled=${navigator.serviceWorker?.controller ? 1 : 0}`);

/* ---------------------------------------------------------------------------
 * The desktop's address, and the other desktops this phone knows
 *
 * Resolution order: URL fragment → ?node= (the spike's shape) → the last
 * address this browser successfully used. The localStorage fallback matters
 * because a launcher, a share sheet or a stripped bookmark can drop a
 * fragment, and losing the address should not look like a broken app. It is
 * safe to persist precisely because it is not a credential.
 *
 * One phone can talk to several desktops — one per Windows user, or one per
 * machine; each is its own agent with its own allowlist, and this device's key
 * is simply paired with each. Every address this browser has used is kept in
 * a list so the header can switch between them. On iOS the list is the only
 * way an installed app reaches a second desktop at all: the app has its own
 * storage, and tapping a link opens Safari rather than the app, so "Add a
 * desktop" takes a pasted link. Switching reloads the page on the other
 * address instead of swapping state in place — everything below assumes one
 * serverId per page load, and a reload keeps that true.
 * ------------------------------------------------------------------------ */
const SERVER_KEY = "hearth-server-id"; // the one used last
const SERVERS_KEY = "hearth-servers";  // [{id, name}], in the order added
const fragment = location.hash ? location.hash.slice(1) : "";
/* Tolerate (and discard) any leftover &pair=… from a pre-0.3 QR still living
 * in someone's saved start URL: the id is the part before the first '&'. */
const fragId = fragment.split("&")[0];
let stored = null;
try { stored = localStorage.getItem(SERVER_KEY); } catch { /* private mode */ }
const serverId =
  fragId || new URLSearchParams(location.search).get("node") || stored || "";
if (serverId && serverId !== stored) {
  try { localStorage.setItem(SERVER_KEY, serverId); } catch { /* private mode */ }
}

let servers = null;
try { servers = JSON.parse(localStorage.getItem(SERVERS_KEY)); } catch { /* corrupt */ }
/* A phone from before the list existed knows exactly one desktop: the stored
 * one. It is kept even when this load is for a different desktop. Only on that
 * first run — afterwards the list is the record, and a desktop removed from it
 * must stay removed. */
if (!Array.isArray(servers)) servers = stored ? [{ id: stored, name: "" }] : [];
servers = servers.filter((s) => s && typeof s.id === "string" && s.id);
if (serverId && !servers.some((s) => s.id === serverId)) servers.push({ id: serverId, name: "" });
saveServers();

function saveServers() {
  try { localStorage.setItem(SERVERS_KEY, JSON.stringify(servers)); } catch { /* private mode */ }
}

/* Until it is renamed, a desktop is called by the start of its id — the same
 * characters the owner can see at the end of its link. */
function serverName(s) {
  return s.name || `Desktop ${s.id.slice(0, 6)}`;
}

/* The endpoint id out of whatever was pasted: the full link, the fragment, or
 * the bare id. Only a shape check — the wasm parses it properly on connect. */
function parseAddress(text) {
  const t = text.trim();
  const id = (t.includes("#") ? t.slice(t.indexOf("#") + 1) : t).split("&")[0].trim();
  return /^[0-9A-Za-z]{16,}$/.test(id) ? id : "";
}

/* Load the page on another desktop's address. `window.history`, because
 * `history` below is the chat cache. Only the fragment changes, which by itself
 * would not reload — hence the explicit reload. Query parameters are dropped so
 * a test hook like ?auto= cannot fire again against the new desktop. */
function openServer(id) {
  window.history.replaceState(null, "", `${location.pathname}#${id}`);
  location.reload();
}

/* This browser's stable device identity (its iroh secret key, hex). Created
 * on first visit, reused on every load — the desktop's allowlist stores the
 * public half, so losing this (clearing browser data) unpairs the device;
 * recovery is pairing again with a fresh code. It never leaves this browser. */
const DEVICE_KEY = "hearth-device-secret";

/* A rough human name for the device list ("iPhone", not a UA string). */
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac browser";
  if (/Windows/.test(ua)) return "Windows browser";
  if (/Linux/.test(ua)) return "Linux browser";
  return "browser";
}

/* Display cache only (instant paint while we fetch the real transcript).
 * The desktop's copy always wins; see fetchHistory(). */
const HISTORY_KEY = `hearth-history-${serverId}`;
const HISTORY_LIMIT = 200;
let history = [];
try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { /* corrupt cache */ }

let client = null;
/* True once the rendered conversation is the desktop's copy, not the cache. */
let historySynced = false;
/* Warnings already shown, so a chat reply does not repeat the load-time one. */
const shownNotices = new Set();

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "err" : "";
}

/**
 * A persistent, honest banner above the conversation. Used for exactly two
 * things: "this app updated" and "this app is out of date". Both are
 * statements about the code the user is running, which is not something to
 * bury in the chat log.
 */
function showNotice(text, actionLabel, action) {
  if (shownNotices.has(text)) return;
  shownNotices.add(text);
  noticeEl.replaceChildren();
  noticeEl.appendChild(document.createTextNode(text + " "));
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.textContent = actionLabel;
    btn.className = "notice-btn";
    btn.onclick = action;
    noticeEl.appendChild(btn);
  }
  noticeEl.hidden = false;
}

function addBubble(role, text, cls = "") {
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}`.trim();
  // Render a deliberately tiny subset of markdown. Models emit **bold** and
  // *italic* by reflex even when told not to, and raw asterisks on screen make
  // the whole thing look broken. Built from a text node and element nodes
  // rather than innerHTML so model output can never inject markup.
  renderInline(div, text);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

// A turn can run for minutes while the agent reads files or runs tools, and a
// still "…" looks the same as a hung one. The dots say it is alive; the counter
// says for how long. Same remove() as a bubble, so every exit path in send()
// already cleans it up.
function addWorking() {
  const div = document.createElement("div");
  div.className = "msg agent pending";
  const dots = document.createElement("span");
  dots.className = "dots";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
  const label = document.createElement("span");
  div.append(dots, label);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  const start = Date.now();
  const tick = () => { label.textContent = `working ${elapsed(Date.now() - start)}`; };
  tick();
  const timer = setInterval(tick, 1000);
  return { remove() { clearInterval(timer); div.remove(); } };
}

function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function saveHistory(role, text) {
  history.push({ role, text });
  // Cap the display cache; the desktop holds the real transcript.
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* quota */ }
}

async function main() {
  registerServiceWorker();

  if (!serverId) {
    setStatus("no desktop id in URL", true);
    addBubble("agent", "This link is missing the desktop's id. Open the exact link (or QR) your desktop shows — it ends with #<endpoint-id> — or tap Desktops above and paste it.", "error");
    return;
  }
  // Instant paint from the offline cache — visibly provisional (dimmed via
  // #chat.stale) so stale local state is never presented as the conversation.
  if (history.length) {
    chatEl.classList.add("stale");
    for (const m of history) addBubble(m.role, m.text);
  }
  try {
    setStatus("loading…");
    await init({ module_or_path: WASM_BIN });
    setStatus("starting iroh…");
    let deviceSecret = null;
    try { deviceSecret = localStorage.getItem(DEVICE_KEY); } catch { /* private mode */ }
    client = await HearthClient.spawn(deviceSecret ?? undefined);
    try { localStorage.setItem(DEVICE_KEY, client.secret_hex()); } catch { /* private mode: pairing won't survive reload */ }

    // Ask the desktop whether this device is trusted before showing anything
    // about pairing. Whether we are paired is a question only the desktop can
    // answer, and asking it is what makes an already-paired device silent —
    // the second of the three 2026-08-17 bugs was offering to pair on every
    // launch because a saved URL still looked like an offer.
    const denied = await fetchHistory();
    if (denied) {
      offerPairing();
      return;
    }
    // Endpoints rotate silently, so the desktop is handed this browser's
    // subscription again on every open (R7.5). Not awaited: chat is ready now.
    resyncPush();
    // Input stays enabled when merely offline (retrying surfaces the same
    // failure honestly).
    sendBtn.disabled = false;
    msgEl.focus();

    const auto = new URLSearchParams(location.search).get("auto");
    if (auto) { msgEl.value = auto; send(true); }
  } catch (e) {
    setStatus("failed to start", true);
    addBubble("agent", `Could not start: ${e}`, "error");
  }
}

/* Surface a desktop-side warning (currently only the version handshake).
 * Rendered as its own banner with a Reload action, because the honest fix for
 * "you are running old code" is to fetch new code. */
function handleWarning(warning) {
  if (warning) showNotice(warning, "Reload", () => location.reload());
}

/* Fetch the authoritative transcript tail from the desktop and make it the
 * rendered conversation, replacing whatever the cache painted. On failure the
 * cached render stays dimmed — honest about being possibly stale — and input
 * is still enabled so the user can try a message (which will surface the same
 * unreachability clearly). Returns true if the desktop refused this device
 * as unpaired (a different failure from "unreachable", and rendered as such). */
async function fetchHistory() {
  setStatus("catching up…");
  try {
    const result = await client.history(serverId, HISTORY_LIMIT, CLIENT_VERSION);
    const turns = result.turns || [];
    handleWarning(result.warning);
    history = turns.map((t) => ({ role: t.role === "user" ? "user" : "agent", text: t.text }));
    chatEl.replaceChildren();
    chatEl.classList.remove("stale");
    for (const m of history) addBubble(m.role, m.text);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* quota */ }
    historySynced = true;
    setStatus("ready");
    const lastText = history.length ? history[history.length - 1].text : "";
    probe(`./__hearth_history__n=${history.length}&last=${encodeURIComponent(lastText.slice(0, 120))}`);
  } catch (e) {
    // The wasm layer marks an authorization refusal with this prefix so we
    // can tell "not paired" from "desktop unreachable" (see src/wasm.rs).
    if (String(e).includes("DENIED: ")) {
      // Also drop the offline cache: a revoked device must not keep showing
      // the conversation it used to be allowed to see.
      chatEl.replaceChildren();
      chatEl.classList.remove("stale");
      history = [];
      try { localStorage.removeItem(HISTORY_KEY); } catch { /* private mode */ }
      probe(`./__hearth_history__denied=1`);
      setStatus("not paired", true);
      return true;
    }
    setStatus("couldn't catch up — is your desktop running?", true);
  }
  return false;
}

async function send(isAuto = false) {
  const text = msgEl.value.trim();
  if (!text || sendBtn.disabled) return;
  msgEl.value = "";
  sendBtn.disabled = true;
  addBubble("user", text);
  saveHistory("user", text);
  const pending = addWorking();

  let outcome = { ok: false, reply: "" };
  try {
    setStatus("connecting…");
    const stream = client.send(serverId, text, CLIENT_VERSION);
    const reader = stream.getReader();
    let received = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const ev = value;
      if (ev.type === "connected") {
        setStatus("thinking…");
      } else if (ev.type === "received") {
        received = true;
        pending.remove();
        handleWarning(ev.warning);
        if (ev.error) {
          // The desktop answered but the agent failed (model down, etc.).
          addBubble("agent", `Agent error: ${ev.error}`, "error");
          setStatus("agent error", true);
        } else {
          addBubble("agent", ev.reply);
          saveHistory("agent", ev.reply);
          setStatus("ready");
          outcome = { ok: true, reply: ev.reply };
          // If the load-time catch-up failed, this reply proves the desktop
          // is reachable again — fetch the real transcript now.
          if (!historySynced) fetchHistory();
        }
      } else if (ev.type === "denied") {
        // The desktop answered and refused us: unpaired (or just revoked).
        received = true;
        pending.remove();
        setStatus("not paired", true);
        offerPairing();
      } else if (ev.type === "closed") {
        if (ev.error && !received) {
          // Never connected or dropped before replying: the desktop itself
          // is unreachable — distinct from an agent error above.
          pending.remove();
          addBubble("agent", `Could not reach your desktop. Is hearth-desktop running?\n(${ev.error})`, "error");
          setStatus("desktop unreachable", true);
        }
      }
    }
  } catch (e) {
    pending.remove();
    addBubble("agent", `Send failed: ${e}`, "error");
    setStatus("error", true);
  } finally {
    // Safety net for a stream that closes cleanly without an outcome: the
    // branches above remove it in order, and a second remove() is a no-op.
    pending.remove();
    sendBtn.disabled = false;
    if (isAuto) {
      // Unconditional (not via probe()): ?auto= is itself the opt-in.
      const q = `ok=${outcome.ok ? 1 : 0}&reply=${encodeURIComponent(outcome.reply.slice(0, 200))}`;
      fetch(`./__hearth_result__${q}`).catch(() => {});
    }
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
switchBtn.addEventListener("click", toggleDesktops);
renderSwitcher();
main();

/* ---------------------------------------------------------------------------
 * Switching desktops
 * ------------------------------------------------------------------------ */

function renderSwitcher() {
  const current = servers.find((s) => s.id === serverId);
  switchBtn.textContent = `${current ? serverName(current) : "Desktops"} ▾`;
}

function menuButton(label, cls, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `menu-item ${cls}`.trim();
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

function toggleDesktops() {
  if (!menuEl.hidden) { menuEl.hidden = true; return; }
  menuEl.replaceChildren();
  for (const s of servers) {
    const here = s.id === serverId;
    menuEl.appendChild(menuButton(
      `${here ? "✓ " : ""}${serverName(s)}`,
      here ? "current" : "",
      () => { if (here) menuEl.hidden = true; else openServer(s.id); },
    ));
  }
  menuEl.appendChild(menuButton("Add a desktop…", "action", addDesktop));
  const current = servers.find((s) => s.id === serverId);
  if (current) {
    menuEl.appendChild(menuButton("Rename this one…", "action", () => renameDesktop(current)));
    menuEl.appendChild(menuButton("Remove this one…", "action", () => removeDesktop(current)));
    if (!pushSupported()) {
      const b = menuButton("Notifications need Hearth on your Home Screen", "action", null);
      b.disabled = true;
      menuEl.appendChild(b);
    } else if (pushOnHere()) {
      menuEl.appendChild(menuButton("✓ Notifications on (turn off)", "action", disableNotifications));
    } else {
      menuEl.appendChild(menuButton("Turn on notifications", "action", enableNotifications));
    }
  }
  menuEl.hidden = false;
}

/*
 * Notifications (docs/ENGINEERING_REQUIREMENTS.md §7). The desktop is the push
 * server: it hands over its VAPID key, the browser subscribes with it, and the
 * subscription goes back to the desktop over iroh. The desktop pushes only a
 * reply this phone did not read live.
 *
 * A browser holds one push subscription per site, bound to one desktop's key,
 * so notifications come from one desktop at a time: the last one they were
 * turned on for. iOS offers PushManager only to a Home Screen app.
 */
const PUSH_KEY = "hearth-push-server";

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function pushServer() {
  try { return localStorage.getItem(PUSH_KEY); } catch { return null; }
}

function pushOnHere() {
  return pushSupported() && Notification.permission === "granted" && pushServer() === serverId;
}

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(buffer, bytes) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((x, i) => x === bytes[i]);
}

async function sendSubscription(sub) {
  const j = sub.toJSON();
  await client.subscribe(serverId, j.endpoint, j.keys.p256dh, j.keys.auth, CLIENT_VERSION);
}

async function enableNotifications() {
  menuEl.hidden = true;
  if (!client) { setStatus("still starting — try again in a moment", true); return; }
  // The permission prompt first, while this is still the tap: iOS shows it
  // only from a user gesture, and any await before it spends the gesture.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") { setStatus("notifications not allowed", true); return; }
  try {
    setStatus("turning notifications on…");
    const key = b64urlBytes(await client.pushKey(serverId, CLIENT_VERSION));
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // Bound to another desktop's key: that desktop loses notifications, and
    // finds out from the push service the next time it tries.
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await sendSubscription(sub);
    try { localStorage.setItem(PUSH_KEY, serverId); } catch { /* private mode */ }
    setStatus("notifications on");
  } catch (e) {
    setStatus("could not turn notifications on", true);
    addBubble("agent", `Notifications: ${e}`, "error");
  }
}

async function disableNotifications() {
  menuEl.hidden = true;
  // The desktop keeps the old subscription until its next push comes back
  // 410, and then forgets it. Nothing to tell it now.
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* already gone */ }
  try { localStorage.removeItem(PUSH_KEY); } catch { /* private mode */ }
  setStatus("notifications off");
}

async function resyncPush() {
  if (!pushOnHere()) return;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    // Safari clearing site data takes the subscription with it; show the
    // switch as off so turning it back on is one tap.
    if (sub) await sendSubscription(sub);
    else localStorage.removeItem(PUSH_KEY);
  } catch { /* the next open tries again */ }
}

/**
 * The switcher's own dialog, drawn in the menu panel. Not prompt()/confirm():
 * installed iOS home-screen apps have a history of making the native dialogs
 * return at once, which would leave add, rename and remove dead on exactly
 * the platform they exist for — while every Chromium test still passed.
 *
 * With `value` it asks for text and resolves to what was typed; without, it
 * asks yes/no and resolves to true. Cancel resolves to null.
 */
function ask(message, { value = null, okLabel = "OK", alt = null } = {}) {
  return new Promise((resolve) => {
    const f = document.createElement("form");
    f.className = "ask";
    const p = document.createElement("p");
    p.textContent = message;
    f.appendChild(p);
    let input = null;
    if (value !== null) {
      input = document.createElement("input");
      input.value = value;
      input.autocapitalize = "off";
      input.autocomplete = "off";
      input.autocorrect = "off";
      input.spellcheck = false;
      f.appendChild(input);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ask-cancel";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.textContent = okLabel;
    const row = document.createElement("div");
    row.className = "ask-row";
    row.append(cancel, ok);
    // `alt`: a third answer, e.g. "Scan QR" instead of typing.
    let altBtn = null;
    if (alt) {
      altBtn = document.createElement("button");
      altBtn.type = "button";
      altBtn.className = "ask-alt";
      altBtn.textContent = alt.label;
      row.prepend(altBtn);
    }
    f.appendChild(row);
    const done = (answer) => { menuEl.hidden = true; menuEl.replaceChildren(); resolve(answer); };
    cancel.onclick = () => done(null);
    if (altBtn) altBtn.onclick = () => done(alt.value);
    f.onsubmit = (e) => { e.preventDefault(); done(input ? input.value : true); };
    menuEl.replaceChildren(f);
    menuEl.hidden = false;
    (input || ok).focus();
  });
}

async function addDesktop() {
  const scan = canScan() ? { label: "Scan QR", value: SCAN } : null;
  let message = scan
    ? "Scan the QR code in the other desktop's Settings, or paste its Hearth link:"
    : "Paste the Hearth link from the other desktop:";
  let text = "";
  let id = "";
  while (!id) {
    const got = await ask(message, { value: text, okLabel: "Add", alt: scan });
    if (got === null) return;
    if (got === SCAN) {
      const scanned = await scanQR();
      if (scanned === null) continue; // cancelled: back to the dialog as it was
      if (typeof scanned !== "string") {
        message = `The camera isn't available here (${scanned.error?.name || scanned.error}). Paste the link instead:`;
        continue;
      }
      text = scanned;
    } else {
      text = got;
    }
    id = parseAddress(text);
    if (!id) {
      message = looksLikePairingCode(text)
        ? "That's a pairing code, and it comes next. First add the desktop: scan its QR code or paste its link."
        : "That doesn't look like a Hearth link. It ends with # and a long id. Try again:";
    }
  }
  if (!servers.some((s) => s.id === id)) {
    servers.push({ id, name: "" });
    saveServers();
  }
  openServer(id);
}

/*
 * Adding a desktop by QR, from inside the app. Most phones share no clipboard
 * with the computer, and nobody should type a 64-character id. The phone's own
 * camera is no help either: on iOS it opens the link in Safari, whose storage
 * is not the Home Screen app's, so a desktop added there never arrives here.
 * BarcodeDetector where the browser has it (Chrome, Android); otherwise jsQR
 * (web/vendor, Apache-2.0), loaded only the first time someone scans.
 */
const SCAN = Symbol("scan");

function canScan() {
  return !!navigator.mediaDevices?.getUserMedia;
}

/** The desktop's typed code alphabet (src/devices.rs ALPHABET), 8 long. */
function looksLikePairingCode(text) {
  return /^[2-9A-HJKMNP-Z]{8}$/.test(text.toUpperCase().replace(/[^0-9A-Z]/g, ""));
}

let jsQRLoad = null;
function loadJsQR() {
  jsQRLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `./vendor/jsQR.js?v=${CLIENT_VERSION}`;
    s.onload = () => resolve(window.jsQR?.default || window.jsQR);
    s.onerror = () => { jsQRLoad = null; reject(new Error("could not load the QR reader")); };
    document.head.appendChild(s);
  });
  return jsQRLoad;
}

/* Resolves to the scanned Hearth link, to null if cancelled, or to {error} if
 * the camera could not be used. Only a QR that parses as a Hearth address ends
 * the scan, so a stray code in the frame is reported and ignored. */
function scanQR() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "scan";
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", ""); // iOS: without it, video goes fullscreen
    const hint = document.createElement("p");
    hint.textContent = "Point the camera at the QR code in the desktop's Settings.";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    overlay.append(video, hint, cancel);
    document.body.appendChild(overlay);

    let stream = null;
    let timer = null;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(value);
    };
    cancel.onclick = () => finish(null);

    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (finished) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        video.srcObject = stream;
        await video.play();
        const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
        const decode = detector ? null : await loadJsQR();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tick = async () => {
          if (finished) return;
          let text = null;
          if (video.videoWidth) {
            if (detector) {
              const codes = await detector.detect(video).catch(() => []);
              if (finished) return; // cancelled during the await
              text = codes[0]?.rawValue ?? null;
            } else {
              // 640 px across is plenty for a QR on a screen, and keeps a
              // phone's decode loop cheap.
              const scale = Math.min(1, 640 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              // Both: the desktop window may be in dark mode, which inverts it.
              text = decode(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
            }
          }
          // A scan must be a Hearth link (#id), not just any long token:
          // stray QRs are what a camera sees, and a bare product code would
          // otherwise add a desktop that can never connect (Bilby, #14).
          if (text && text.includes("#") && parseAddress(text)) { finish(text); return; }
          if (text) hint.textContent = "That QR isn't a Hearth link. Point at the one in the desktop's Settings.";
          timer = setTimeout(tick, 150);
        };
        tick();
      } catch (error) {
        finish({ error });
      }
    })();
  });
}

async function renameDesktop(s) {
  const name = await ask("Name this desktop:", { value: s.name || serverName(s), okLabel: "Save" });
  if (name === null) return;
  s.name = name.trim().slice(0, 40);
  saveServers();
  renderSwitcher();
}

/* Forgetting a desktop here does not unpair this phone — the desktop's
 * allowlist is the authority on that, and only revoking there removes it. */
async function removeDesktop(s) {
  const sure = await ask(
    `Remove "${serverName(s)}" from this phone? The desktop still trusts this phone until you revoke it there.`,
    { okLabel: "Remove" },
  );
  if (!sure) return;
  servers = servers.filter((x) => x.id !== s.id);
  saveServers();
  try { localStorage.removeItem(`hearth-history-${s.id}`); } catch { /* private mode */ }
  // The last-used fallback must not point at what was just removed, or a
  // launch without a fragment would open (and re-list) it.
  try { localStorage.removeItem(SERVER_KEY); } catch { /* private mode */ }
  if (servers.length) { openServer(servers[0].id); return; }
  window.history.replaceState(null, "", location.pathname);
  location.reload();
}

/**
 * Minimal, injection-safe inline markdown.
 *
 * Handles **bold**, *italic* and `code` only. Everything else is left as
 * literal text. Deliberately does NOT use innerHTML: the text comes from a
 * language model, and giving model output a path to markup would be a
 * self-inflicted XSS.
 */
function renderInline(el, text) {
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tag = m[1] ? 'strong' : m[2] ? 'em' : 'code';
    const node = document.createElement(tag);
    node.textContent = m[1] || m[2] || m[3];
    el.appendChild(node);
    last = pattern.lastIndex;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

/* ---------------------------------------------------------------------------
 * Updates
 * ------------------------------------------------------------------------ */

/**
 * Register the service worker and say so when a new build takes over.
 *
 * The worker itself does the network-first work (see web/sw.js); this half is
 * only about telling the user. `controllerchange` fires when a newly installed
 * worker calls clients.claim() — at that moment the *page* is still running
 * the code it loaded, so the honest thing to say is "reload", not to silently
 * swap under someone's fingers mid-sentence.
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Only a *change* is news. The first-ever registration also fires this
    // (nothing → us), and announcing "updated" on first launch is a lie.
    if (!hadController) return;
    probe(`./__hearth_client__updated=1&version=${CLIENT_VERSION}`);
    showNotice("Hearth updated in the background.", "Reload", () => location.reload());
  });
  navigator.serviceWorker.register("./sw.js").catch((e) => {
    // Not fatal: without a worker the app still runs, it just loses offline
    // start and has to rely on HTTP caching for updates. Say so in the console
    // rather than failing the page.
    console.warn("service worker registration failed", e);
  });
}

/* ---------------------------------------------------------------------------
 * Pairing
 * ------------------------------------------------------------------------ */

/** True when running as an installed home-screen app rather than a browser tab. */
function isStandalone() {
  return window.navigator.standalone === true
    || window.matchMedia("(display-mode: standalone)").matches;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Ask for the pairing code. Shown only when the desktop has actually refused
 * this device, so an already-paired device never sees it.
 *
 * The code is typed rather than carried in the link on purpose: a link is an
 * address and gets saved, cached and re-launched, and a single-use secret
 * cannot survive that. Typing also makes granting a device access to
 * everything the agent remembers a deliberate act rather than a side effect of
 * opening a URL.
 */
function offerPairing() {
  if (document.getElementById("pair-form")) return; // already asking
  setStatus("not paired", true);
  sendBtn.disabled = true;

  addBubble(
    "agent",
    "This device isn't paired yet.\n\nOn your desktop run `hearth-desktop pair` "
    + "and type the code it prints below. The code is good for five minutes and "
    + "works once.",
  );

  if (isIOS() && !isStandalone()) {
    addBubble(
      "agent",
      "On iPhone, install first: tap Share, then Add to Home Screen, and open "
      + "Hearth from the new icon. An installed app gets its own storage on iOS, "
      + "so pairing here in Safari would not carry over — and only an installed "
      + "app can receive notifications. The link is safe to install at any time; "
      + "it holds no secret.",
    );
  }

  const wrap = document.createElement("form");
  wrap.id = "pair-form";
  const input = document.createElement("input");
  input.id = "pair-code";
  input.placeholder = "Pairing code";
  // A phone keyboard will otherwise autocapitalise, autocorrect and offer to
  // fill a password. The code is uppercase and unambiguous by construction
  // (no O/0, no I/1/L), so ask for exactly that.
  input.autocapitalize = "characters";
  input.autocomplete = "one-time-code";
  input.autocorrect = "off";
  input.spellcheck = false;
  input.maxLength = 12; // 8 characters plus separators the desktop strips
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.textContent = "Pair";
  wrap.append(input, btn);

  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    btn.disabled = true;
    input.disabled = true;
    setStatus("pairing…");
    try {
      await client.pair(serverId, code, deviceName(), CLIENT_VERSION);
      wrap.remove();
      addBubble("agent", "Paired. This device is now trusted.");
      const denied = await fetchHistory();
      if (!denied) { sendBtn.disabled = false; msgEl.focus(); }
    } catch (err) {
      btn.disabled = false;
      input.disabled = false;
      input.select();
      setStatus("pairing failed", true);
      // The desktop's reason is the useful part (wrong code / expired / out of
      // attempts), so show it rather than a generic failure.
      addBubble("agent", `${String(err).replace(/^Error:\s*/, "")}`, "error");
    }
  };

  chatEl.appendChild(wrap);
  wrap.scrollIntoView({ block: "nearest" });
  input.focus();
}
