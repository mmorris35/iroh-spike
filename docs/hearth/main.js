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
const CLIENT_VERSION = "0.4.7";
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
/* How an attached file is shown: an allow-list judged from its bytes (B2 in
 * Bilby's review of #79). Versioned like the wasm so a new shell never runs
 * last build's copy. */
const { prepareFile, presentFile } = await import(new URL(`./files.js?v=${CLIENT_VERSION}`, import.meta.url).href);

const chatEl = document.getElementById("chat");
const statusEl = document.getElementById("status");
const msgEl = document.getElementById("msg");
const sendBtn = document.getElementById("send");
const form = document.getElementById("composer");
const attachBtn = document.getElementById("attach");
const fileEl = document.getElementById("file");
const chipsEl = document.getElementById("chips");
const noticeEl = document.getElementById("notice");
const switchBtn = document.getElementById("switch");
const menuEl = document.getElementById("desktops");
const householdBtn = document.getElementById("household-btn");
const householdEl = document.getElementById("household");

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
let servers = null;
try { servers = JSON.parse(localStorage.getItem(SERVERS_KEY)); } catch { /* corrupt */ }

/* An installed app always launches the URL it was installed from, so on a
 * cold launch its fragment names the FIRST desktop, not the one last used, and
 * every launch reverted to it (Mike, 2026-09-26). So an installed app's cold
 * launch opens the last-used desktop instead. The fragment still wins for a
 * switch inside the app (openServer marks it), for a tapped notification
 * (?via=push), and in a browser tab, where the URL is what was just opened. */
const installed = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
let switching = false;
try { switching = sessionStorage.getItem("hearth-switching") === "1"; sessionStorage.removeItem("hearth-switching"); } catch { /* private mode */ }
const deepLink = new URLSearchParams(location.search).has("via");
const known = Array.isArray(servers) && servers.some((s) => s && s.id === stored);
const launchLast = installed && !switching && !deepLink && fragId && stored && stored !== fragId && known;
if (launchLast) window.history.replaceState(null, "", `${location.pathname}#${stored}`);
// ?via has done its job once read: drop it, so the address bar stays the
// plain desktop URL (Bilby's review of #17), as openServer does with ?auto=.
else if (deepLink) window.history.replaceState(null, "", `${location.pathname}${location.hash}`);

const serverId = launchLast
  ? stored
  : fragId || new URLSearchParams(location.search).get("node") || stored || "";
if (serverId && serverId !== stored) {
  try { localStorage.setItem(SERVER_KEY, serverId); } catch { /* private mode */ }
}

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
  // Tells the next load this fragment was chosen, not the app's saved launch URL.
  try { sessionStorage.setItem("hearth-switching", "1"); } catch { /* private mode */ }
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
// This device's key, kept so a dropped connection can get a fresh client (#71).
let deviceSecret = null;
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
  // A file the agent attached is a `[file <id>: <name>]` line under its reply
  // (src/protocol.rs, file_marker), written by the desktop's engine, never by
  // the model. Only an agent's line is read as one.
  const { body, files } = role === "agent" ? splitFiles(text) : { body: text, files: [] };
  // Render a deliberately tiny subset of markdown. Models emit **bold** and
  // *italic* by reflex even when told not to, and raw asterisks on screen make
  // the whole thing look broken. Built from a text node and element nodes
  // rather than innerHTML so model output can never inject markup.
  renderInline(div, body);
  for (const f of files) div.appendChild(fileCard(f));
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

// ---- Files from the agent -----------------------------------------------

const FILE_LINE = /^\[file ([0-9a-fA-F]{32}): (.+)\]$/;

/* A reply's text without its file lines, and the files they name. */
function splitFiles(text) {
  const files = [];
  const kept = [];
  for (const line of String(text).split("\n")) {
    const m = FILE_LINE.exec(line.trim());
    if (m) files.push({ id: m[1], name: m[2] });
    else kept.push(line);
  }
  return { body: files.length ? kept.join("\n").trimEnd() : text, files };
}

/* Fetched files by id, as object URLs, so a second tap does not fetch again. */
const fetchedFiles = new Map();

/* A file under a reply: tap to fetch it from the desktop over iroh (the same
 * encrypted, paired-only connection a message uses), then a PNG, JPEG, GIF or
 * WebP shows inline, a PDF opens in the browser's viewer, and anything else
 * only downloads (web/files.js). */
function fileCard(f) {
  const card = document.createElement("div");
  card.className = "file";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = `Open ${f.name}`;
  const note = document.createElement("span");
  note.className = "file-note";
  card.append(btn, note);
  btn.addEventListener("click", async () => {
    if (!client) { note.textContent = "not connected yet"; return; }
    btn.disabled = true;
    note.textContent = "fetching…";
    try {
      let got = fetchedFiles.get(f.id);
      if (!got) {
        const file = await client.download(serverId, f.id, CLIENT_VERSION);
        got = prepareFile(file.name, file.data, file.mime);
        try { file.free(); } catch { /* already freed */ }
        fetchedFiles.set(f.id, got);
      }
      note.textContent = "";
      presentFile(card, btn, got);
    } catch (e) {
      note.textContent = String(e).includes("DENIED: ") ? "this device is not paired" : `couldn't fetch it: ${e}`;
    } finally {
      btn.disabled = false;
    }
  });
  return card;
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
  let doing = "working";
  const tick = () => { label.textContent = `${doing} ${elapsed(Date.now() - start)}`; };
  tick();
  const timer = setInterval(tick, 1000);
  return {
    remove() { clearInterval(timer); div.remove(); },
    // What the wait is now, e.g. "reconnecting…", so a dropped turn reads as in hand (#71).
    note(text) { doing = text; tick(); },
  };
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
    try { deviceSecret = localStorage.getItem(DEVICE_KEY); } catch { /* private mode */ }
    client = await HearthClient.spawn(deviceSecret ?? undefined);
    deviceSecret = client.secret_hex();
    try { localStorage.setItem(DEVICE_KEY, deviceSecret); } catch { /* private mode: pairing won't survive reload */ }

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
    // The super user's phone shows devices waiting to join (R2.1).
    watchJoins();
    // The household settings screen, if the desktop will serve it to this
    // device (super user only; the desktop decides).
    offerHousehold();
    // Input stays enabled when merely offline (retrying surfaces the same
    // failure honestly).
    setComposer(true);
    msgEl.focus();
    // Replies to turns a killed or reloaded page left in flight (#71).
    resumePending();

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

// ---- Attachments --------------------------------------------------------
// Files ride their own op: each is uploaded (and stored on the desktop) before
// the message, which then names them by id. The limits mirror the desktop's
// (src/attachments.rs) so a refusal is said here, before any bytes move; the
// desktop still enforces them.
const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
let attached = [];

/** Send and 📎 are enabled together: both mean "a turn can start now". */
function setComposer(on) {
  sendBtn.disabled = !on;
  attachBtn.disabled = !on;
}

function renderChips() {
  chipsEl.replaceChildren();
  chipsEl.hidden = attached.length === 0;
  attached.forEach((file, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("span");
    name.textContent = file.name;
    name.title = `${file.name} (${sizeLabel(file.size)})`;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${file.name}`);
    x.addEventListener("click", () => { attached.splice(i, 1); renderChips(); });
    chip.append(name, x);
    chipsEl.appendChild(chip);
  });
}

function sizeLabel(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Add picked files, refusing (out loud) the ones the desktop would refuse. */
function addFiles(files) {
  const refused = [];
  for (const file of files) {
    if (attached.length >= MAX_FILES) { refused.push(`${file.name}: ${MAX_FILES} files per message`); continue; }
    if (file.size === 0) { refused.push(`${file.name}: empty`); continue; }
    if (file.size > MAX_FILE_BYTES) { refused.push(`${file.name}: over ${MAX_FILE_BYTES / 1024 / 1024} MB`); continue; }
    attached.push(file);
  }
  renderChips();
  if (refused.length) addBubble("agent", `Not attached:\n${refused.join("\n")}`, "error");
}

attachBtn.addEventListener("click", () => fileEl.click());
fileEl.addEventListener("change", () => { addFiles(Array.from(fileEl.files || [])); fileEl.value = ""; });

// The last message whose reply never arrived: sent again with the same
// text, it keeps its id, so the desktop answers with the first send's reply
// instead of running it twice (#66: a cold first turn timed out on the phone
// while the desktop finished it).
let unanswered = null;

function messageId(text) {
  if (unanswered && unanswered.text === text && Date.now() - unanswered.at < 60 * 60 * 1000) return unanswered.id;
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* ---------------------------------------------------------------------------
 * Replies that outlive the phone's attention (#71)
 *
 * A turn can run for minutes. If the phone is locked or the app backgrounded
 * meanwhile, iOS suspends the page, iroh's keep-alives stop, and after 30 s the
 * connection is gone, though the desktop finishes the turn and keeps its
 * answer for an hour by (device, message id) (#66). So a dropped turn is not
 * an error: the page sends the SAME message id again — after a backoff, when
 * the page is visible again, or when the network comes back — and the desktop
 * answers with the finished reply (or waits for the running one), never
 * running the turn twice. Each attempt after a drop uses a fresh client
 * endpoint: the one that died in suspension never recovers (a page refresh was
 * the only cure). Turns in flight are kept in localStorage, so a page iOS
 * killed outright still collects its reply when reopened. "Could not reach
 * your desktop" is shown only when the whole budget has passed.
 * ------------------------------------------------------------------------ */
const PENDING_KEY = "hearth.pending.v1";
// ?debug in the page URL logs each attempt and event to the console.
const DEBUG = new URLSearchParams(location.search).has("debug");
const dbg = (...a) => { if (DEBUG) console.log("hearth#71", new Date().toISOString(), ...a); };
// The desktop keeps an answer for an hour (TURN_KEPT_FOR); trying for 15 min
// covers a pocketed phone without retrying a dead desktop forever.
const RETRY_BUDGET_MS = 15 * 60 * 1000;
const RETRY_WAITS_MS = [1000, 2000, 5000, 10000, 20000, 30000];
let wake = () => {};

function loadPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "{}"); } catch { return {}; }
}
function savePending(all) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(all)); } catch { /* private mode: lost on reload */ }
}
function rememberTurn(job) {
  const all = loadPending();
  all[job.id] = { server: serverId, text: job.text, attachments: job.attachments, at: job.at };
  savePending(all);
}
function forgetTurn(id) {
  const all = loadPending();
  delete all[id];
  savePending(all);
}

/** Wait `ms`, or less if the page becomes visible or the network returns. */
function pause(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wake = () => {}; resolve(); }
    wake = done;
  });
}
for (const ev of ["online", "pageshow"]) window.addEventListener(ev, () => wake());
// A frozen page (Chrome's page lifecycle) wakes with `resume`.
document.addEventListener("resume", () => wake());

// A page that slept past iroh's 30 s idle limit holds a dead connection, but
// only finds out when its own timers catch up. A gap in this 1 s beat is the
// sleep, seen from the inside: drop the attempt in flight and resend at once.
let inFlight = null;
let sleptAt = 0;
// When the page last came back from a sleep, visible or not: the anchor for
// the time-to-reply number (a page can report hidden for a moment as it wakes).
let wokeAt = 0;
let beat = Date.now();
function checkSlept() {
  const now = Date.now();
  if (now - beat > 25000) wokeAt = now;
  // Only when visible: a hidden page's timers are throttled, which is a gap
  // too but not a sleep (its connection may be fine, and it is not reading).
  if (now - beat > 25000 && !document.hidden) {
    dbg("slept", now - beat, "ms; attempt in flight:", !!inFlight);
    sleptAt = now;
    if (inFlight) inFlight.cancel().catch(() => {});
    wake();
  }
  beat = now;
}
setInterval(checkSlept, 1000);
// The wake events check too, before the timer's next tick can.
for (const ev of ["pageshow", "focus"]) window.addEventListener(ev, checkSlept);
document.addEventListener("resume", checkSlept);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkSlept(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });

/**
 * A fresh client endpoint (same device key), replacing one a drop left dead.
 * The old one is released first: a relay keeps one connection per device key,
 * and two live endpoints with the same key would push each other off it.
 */
async function respawnClient() {
  const old = client;
  try { old?.free?.(); } catch { /* already gone */ }
  try { client = await HearthClient.spawn(deviceSecret ?? undefined); } catch { client = old; /* next attempt tries again */ }
}

/**
 * Run one chat turn to an outcome: `{ok, reply}` on a reply, or `{ok:false}`
 * after an agent error, a refusal, or the whole budget without reaching the
 * desktop. Every attempt carries the same message id.
 */
async function runTurn(job, pending) {
  let attempt = 0;
  let lastError = "";
  while (true) {
    let received = false;
    let outcome = null;
    const startedAt = Date.now();
    dbg("attempt", attempt, job.id);
    try {
      const stream = job.attachments.length
        ? client.sendWith(serverId, job.text || "(see the attached files)", job.attachments, CLIENT_VERSION, job.id)
        : client.send(serverId, job.text, CLIENT_VERSION, job.id);
      const reader = stream.getReader();
      inFlight = reader;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const ev = value;
        dbg("event", ev.type, ev.error || "");
        if (ev.type === "connected") {
          setStatus(attempt ? "reconnected, collecting the reply…" : "thinking…");
          if (attempt) pending.note("collecting the reply…");
        } else if (ev.type === "received") {
          received = true;
          pending.remove();
          handleWarning(ev.warning);
          if (ev.error) {
            // The desktop answered but the agent failed (model down, etc.).
            addBubble("agent", `Agent error: ${ev.error}`, "error");
            setStatus("agent error", true);
            outcome = { ok: false, reply: "" };
          } else {
            // A resumed turn's reply may already be in the transcript the
            // page just fetched: show it once.
            if (!(job.resumed && history.some((h) => h.role === "agent" && h.text === ev.reply))) {
              addBubble("agent", ev.reply);
              saveHistory("agent", ev.reply);
            }
            setStatus("ready");
            outcome = { ok: true, reply: ev.reply };
            if (wokeAt > job.at) noteWakeToReply(Date.now() - wokeAt);
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
          outcome = { ok: false, reply: "" };
        } else if (ev.type === "closed" && ev.error && !received) {
          lastError = ev.error;
        }
      }
    } catch (e) {
      lastError = String(e);
      dbg("threw", lastError);
    } finally {
      inFlight = null;
    }
    if (outcome) return outcome;
    // Dropped before a reply: the turn may well be running or done on the
    // desktop. Try again with the same id, unless the budget is spent.
    if (Date.now() - job.at >= RETRY_BUDGET_MS) {
      pending.remove();
      addBubble("agent", `Could not reach your desktop. Is hearth-desktop running?\n(${lastError})`, "error");
      setStatus("desktop unreachable", true);
      return { ok: false, reply: "" };
    }
    setStatus("connection lost, still waiting for the desktop…");
    pending.note("reconnecting…");
    // Woken from a sleep during this attempt: the desktop is likely done, ask now.
    if (sleptAt < startedAt) await pause(RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)]);
    attempt++;
    await respawnClient();
  }
}

/**
 * How long a reply took after the phone woke up: shown in the status line and
 * kept (last 20) under hearth.wake.v1, so a real-phone test gives a real number
 * rather than an impression (#71).
 */
const WAKE_LOG_KEY = "hearth.wake.v1";
function noteWakeToReply(ms) {
  const secs = Math.round(ms / 1000);
  setStatus(`ready (reply ${secs}s after waking)`);
  try {
    const log = JSON.parse(localStorage.getItem(WAKE_LOG_KEY) || "[]");
    log.push({ at: new Date().toISOString(), secs });
    localStorage.setItem(WAKE_LOG_KEY, JSON.stringify(log.slice(-20)));
  } catch { /* private mode */ }
}

/** Turns a killed or reloaded page left in flight: collect their replies. */
async function resumePending() {
  const all = loadPending();
  for (const [id, p] of Object.entries(all)) {
    // Another desktop's turn, or older than the desktop keeps answers: drop it.
    if (p.server !== serverId || Date.now() - p.at > 60 * 60 * 1000) { forgetTurn(id); continue; }
    const job = { id, text: p.text, attachments: p.attachments || [], at: p.at, resumed: true };
    const pending = addWorking();
    const outcome = await runTurn(job, pending);
    if (outcome.ok || Date.now() - job.at >= RETRY_BUDGET_MS) forgetTurn(id);
  }
}

// Fit the composer to its text; #msg's max-height caps it and it scrolls past
// that. Called on typing and after send() clears it. Code that sets the text
// must call it too (today only ?auto= does, and it sends at once).
function fitComposer() {
  msgEl.style.height = "auto";
  msgEl.style.height = `${msgEl.scrollHeight + 2}px`;
}

async function send(isAuto = false) {
  const text = msgEl.value.trim();
  const files = attached.slice();
  if ((!text && !files.length) || sendBtn.disabled) return;
  const msgId = messageId(text);
  msgEl.value = "";
  fitComposer();
  attached = [];
  renderChips();
  setComposer(false);
  // Same marker the desktop writes into the transcript, so the bubble reads
  // the same now as it will after a history reload.
  const shown = (text || "(attached)") + files.map((f) => `\n[attached: ${f.name}]`).join("");
  addBubble("user", shown);
  saveHistory("user", shown);
  const pending = addWorking();

  let outcome = { ok: false, reply: "" };
  try {
    setStatus("connecting…");
    const ids = [];
    for (const [i, file] of files.entries()) {
      setStatus(files.length > 1 ? `sending file ${i + 1} of ${files.length}…` : "sending file…");
      const data = new Uint8Array(await file.arrayBuffer());
      try {
        ids.push(await client.upload(serverId, file.name, file.type || "application/octet-stream", data, CLIENT_VERSION));
      } catch (e) {
        // Put the unsent files back so the person can retry or drop one.
        attached = files;
        renderChips();
        throw new Error(`${file.name} didn't send: ${String(e).replace(/^Error: /, "")}`);
      }
    }
    const job = { id: msgId, text, attachments: ids, at: Date.now() };
    rememberTurn(job);
    outcome = await runTurn(job, pending);
    if (outcome.ok || Date.now() - job.at >= RETRY_BUDGET_MS) forgetTurn(job.id);
  } catch (e) {
    pending.remove();
    addBubble("agent", `Send failed: ${e}`, "error");
    setStatus("error", true);
  } finally {
    unanswered = outcome.ok ? null : { text, id: msgId, at: Date.now() };
    // Safety net for a stream that closes cleanly without an outcome: the
    // branches above remove it in order, and a second remove() is a no-op.
    pending.remove();
    setComposer(true);
    if (isAuto) {
      // Unconditional (not via probe()): ?auto= is itself the opt-in.
      const q = `ok=${outcome.ok ? 1 : 0}&reply=${encodeURIComponent(outcome.reply.slice(0, 200))}`;
      fetch(`./__hearth_result__${q}`).catch(() => {});
    }
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
// Enter is a newline (a textarea does that itself); Cmd/Ctrl+Enter sends, for
// a keyboard.
msgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); send(); }
});
msgEl.addEventListener("input", fitComposer);
switchBtn.addEventListener("click", toggleDesktops);

// Swipe right to open the desktop picker, as Telegram opens its chat list;
// swipe left to close it. A quick, mostly horizontal swipe only, and never
// one that starts in the composer or a code block, where a drag selects or
// scrolls text.
let swipe = null;
document.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  swipe = e.touches.length === 1 && !e.target.closest("textarea, input, pre")
    ? { x: t.clientX, y: t.clientY, at: Date.now() }
    : null;
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  const quick = Date.now() - swipe.at < 700;
  swipe = null;
  if (!quick || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return;
  if (dx > 0 && menuEl.hidden) toggleDesktops();
  else if (dx < 0 && !menuEl.hidden) closeDesktops();
}, { passive: true });
renderSwitcher();
// In a window wide enough (index.html's 960px layout: iPad landscape, a 13-inch
// iPad either way up, a wide Stage Manager window) the desktop list is docked
// beside the chat and stays open.
const docked = window.matchMedia("(min-width: 960px) and (min-height: 500px)");
if (docked.matches) toggleDesktops();
docked.addEventListener("change", () => {
  if (docked.matches) closeDesktops();
  else if (!menuEl.querySelector("form")) menuEl.hidden = true; // a dialog stays up
});
main();

/* ---------------------------------------------------------------------------
 * Switching desktops
 * ------------------------------------------------------------------------ */

/* "Close" for the desktop list; where it is docked, back to the list. */
function closeDesktops() {
  menuEl.hidden = true;
  if (docked.matches) toggleDesktops();
}

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

/* One desktop in the list: a lettered circle, its name, and the last line of
 * the conversation this phone has cached for it. */
function desktopRow(s) {
  const here = s.id === serverId;
  const row = document.createElement("button");
  row.type = "button";
  row.className = `agent-row${here ? " current" : ""}`;
  row.onclick = () => { if (here) closeDesktops(); else openServer(s.id); };
  const name = serverName(s);
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = (name.trim()[0] || "?").toUpperCase();
  avatar.style.background = avatarColour(s.id);
  const text = document.createElement("span");
  text.className = "agent-text";
  const title = document.createElement("div");
  title.className = "agent-name";
  title.textContent = name;
  const preview = document.createElement("div");
  preview.className = "agent-preview";
  preview.textContent = lastLine(s.id) || " ";
  text.append(title, preview);
  row.append(avatar, text);
  return row;
}

/* The newest cached message for a desktop, on one line. */
function lastLine(id) {
  let h = [];
  try { h = JSON.parse(localStorage.getItem(`hearth-history-${id}`)) || []; } catch { /* corrupt cache */ }
  const m = h[h.length - 1];
  if (!m || typeof m.text !== "string") return "";
  return `${m.role === "user" ? "You: " : ""}${m.text.replace(/\s+/g, " ").trim()}`;
}

/* A steady colour per desktop, so each circle is recognisable at a glance. */
function avatarColour(id) {
  const colours = ["#3b82c4", "#b35fc4", "#d0564a", "#2fa5a0", "#4fa35a", "#d08a2e", "#6b6fd0", "#c4527f"];
  let n = 2166136261; // FNV-1a
  for (const c of id) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return colours[n % colours.length];
}

function toggleDesktops() {
  if (!menuEl.hidden) { menuEl.hidden = true; return; }
  menuEl.replaceChildren();
  const head = document.createElement("div");
  head.className = "list-head";
  const title = document.createElement("h2");
  title.textContent = "Desktops";
  const close = menuButton("✕", "", closeDesktops);
  close.setAttribute("aria-label", "Close");
  head.append(title, close);
  menuEl.appendChild(head);
  for (const s of servers) menuEl.appendChild(desktopRow(s));
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
  closeDesktops();
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
    if (docked.matches) closeDesktops(); // redraw the docked list's switch
  } catch (e) {
    setStatus("could not turn notifications on", true);
    addBubble("agent", `Notifications: ${e}`, "error");
  }
}

async function disableNotifications() {
  closeDesktops();
  // The desktop keeps the old subscription until its next push comes back
  // 410, and then forgets it. Nothing to tell it now.
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* already gone */ }
  try { localStorage.removeItem(PUSH_KEY); } catch { /* private mode */ }
  setStatus("notifications off");
  if (docked.matches) closeDesktops();
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
    const done = (answer) => { menuEl.replaceChildren(); closeDesktops(); resolve(answer); };
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
  if (docked.matches) closeDesktops(); // the docked list shows the new name
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
  setComposer(false);

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
      if (!denied) { setComposer(true); msgEl.focus(); }
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

  // A household agent (house-REQUIREMENTS R2.1) admits devices from its
  // super user's phone instead of a code typed at the desktop. Offered beside
  // the code; a personal agent answers that it takes no join requests.
  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "join-ask";
  ask.textContent = "No code? Ask to join";
  ask.onclick = () => askToJoin(wrap, ask);
  wrap.append(ask);

  chatEl.appendChild(wrap);
  wrap.scrollIntoView({ block: "nearest" });
  input.focus();
}

/* R2.1/R2.2: ask the household's super user to let this device in, then poll
 * until they decide or the request expires (ten minutes, server-side). */
async function askToJoin(form, button) {
  button.disabled = true;
  setStatus("asking to join…");
  const deadline = Date.now() + 10 * 60 * 1000;
  let told = false;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await client.join(serverId, deviceName(), CLIENT_VERSION);
    } catch (err) {
      button.disabled = false;
      setStatus("not paired", true);
      addBubble("agent", String(err).replace(/^Error:\s*/, ""), "error");
      return;
    }
    if (status === "admitted") {
      form.remove();
      // R2.3: a plain notice at first connection.
      addBubble("agent", "You're in. Everything here is shared with the whole family.");
      const denied = await fetchHistory();
      if (!denied) { resyncPush(); setComposer(true); msgEl.focus(); }
      return;
    }
    if (status === "refused") {
      button.disabled = false;
      setStatus("not paired", true);
      addBubble("agent", "The request to join was turned down.", "error");
      return;
    }
    if (!told) {
      addBubble("agent", "Asked to join. Waiting for the household's super user to let this device in (the request lasts ten minutes).");
      told = true;
    }
    setStatus("waiting for approval…");
    await new Promise((r) => setTimeout(r, 5000));
  }
  button.disabled = false;
  setStatus("not paired", true);
  addBubble("agent", "Nobody answered in ten minutes. Ask again when they're around.", "error");
}

/* R2.1: on the super user's phone, devices waiting to join, each with who it
 * belongs to and Admit / Turn away. Anyone else's phone gets a refusal from
 * the desktop and shows nothing. */
let joinsTimer = null;
async function checkJoins() {
  let view;
  try {
    view = await client.joins(serverId, CLIENT_VERSION);
  } catch {
    return; // not the super user, or no household: nothing to show
  }
  for (const el of document.querySelectorAll(".join-request")) {
    if (!view.requests.some((r) => r.device === el.dataset.device)) el.remove();
  }
  for (const r of view.requests) {
    if (document.querySelector(`.join-request[data-device="${CSS.escape(r.device)}"]`)) continue;
    const box = document.createElement("form");
    box.className = "join-request";
    box.dataset.device = r.device;
    const label = document.createElement("div");
    label.textContent = `"${r.name}" wants to join (device ${r.device.slice(0, 8)}…). Whose is it?`;
    const who = document.createElement("select");
    for (const p of view.people) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.name} (${p.role})`;
      who.append(o);
    }
    const admit = document.createElement("button");
    admit.type = "submit";
    admit.textContent = "Admit";
    const refuse = document.createElement("button");
    refuse.type = "button";
    refuse.textContent = "Turn away";
    const decide = async (person) => {
      admit.disabled = refuse.disabled = who.disabled = true;
      try {
        await client.decide(serverId, r.device, person, CLIENT_VERSION);
        box.remove();
        addBubble("agent", person ? `Admitted "${r.name}" as ${who.selectedOptions[0].textContent}.` : `Turned away "${r.name}".`);
      } catch (err) {
        admit.disabled = refuse.disabled = who.disabled = false;
        addBubble("agent", String(err).replace(/^Error:\s*/, ""), "error");
      }
    };
    box.onsubmit = (e) => { e.preventDefault(); decide(who.value); };
    refuse.onclick = () => decide("");
    box.append(label, who, admit, refuse);
    chatEl.appendChild(box);
    box.scrollIntoView({ block: "nearest" });
  }
}
/* R3.2: on a parent's (or the super user's) phone, authority actions waiting
 * for a parent, shown exactly as they would run, with Confirm and Decline.
 * Other phones get a refusal from the desktop and show nothing. */
async function checkConfirmations() {
  let items;
  try {
    items = await client.confirmations(serverId, CLIENT_VERSION);
  } catch {
    return;
  }
  for (const el of document.querySelectorAll(".confirm-request")) {
    if (!items.some((c) => c.id === el.dataset.id)) el.remove();
  }
  for (const c of items) {
    if (document.querySelector(`.confirm-request[data-id="${CSS.escape(c.id)}"]`)) continue;
    const box = document.createElement("div");
    box.className = "confirm-request";
    box.dataset.id = c.id;
    const label = document.createElement("div");
    label.textContent = `Needs a parent (asked on ${c.by}'s turn): ${c.summary}`;
    const yes = document.createElement("button");
    yes.textContent = "Confirm";
    const no = document.createElement("button");
    no.textContent = "Decline";
    const decide = async (approve) => {
      yes.disabled = no.disabled = true;
      try {
        const what = await client.confirm(serverId, c.id, approve, CLIENT_VERSION);
        box.remove();
        addBubble("agent", what);
      } catch (err) {
        yes.disabled = no.disabled = false;
        addBubble("agent", String(err).replace(/^Error:\s*/, ""), "error");
      }
    };
    yes.onclick = () => decide(true);
    no.onclick = () => decide(false);
    box.append(label, yes, no);
    chatEl.appendChild(box);
    box.scrollIntoView({ block: "nearest" });
  }
}

function watchJoins() {
  const check = () => { checkJoins(); checkConfirmations(); };
  check();
  clearInterval(joinsTimer);
  joinsTimer = setInterval(() => { if (!document.hidden) check(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

/* ---------------------------------------------------------------------------
 * Household settings (super user only; src/household.rs)
 *
 * This page displays, sorts and sends; it decides nothing. Whether the screen
 * exists for this device is the desktop's answer to `household`. Every choice
 * list (roles, history settings, tool names) comes from the desktop's
 * `choices`. Every rule (valid ids, quiet-hour times, the last super user, not
 * locking yourself out, someone else saved first) is checked by the desktop,
 * and its reason is shown here verbatim. The page only turns the form back
 * into the JSON file and sends it with the version it was based on.
 * ------------------------------------------------------------------------ */

let household = null;

async function offerHousehold() {
  if (typeof client.household !== "function") return; // an older wasm
  try {
    household = await client.household(serverId, CLIENT_VERSION);
    householdBtn.hidden = false;
  } catch {
    householdBtn.hidden = true; // not the super user, or no household
  }
}

householdBtn.addEventListener("click", () => openHousehold());

async function openHousehold(message = "", isError = false) {
  try {
    household = await client.household(serverId, CLIENT_VERSION);
  } catch (e) {
    householdEl.hidden = true;
    householdBtn.hidden = true;
    setStatus(errText(e), true);
    return;
  }
  renderHousehold(message, isError);
  householdEl.hidden = false;
}

function errText(e) {
  return String(e).replace(/^Error:\s*/, "");
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "dataset") Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function select(options, value) {
  const s = el("select");
  for (const [v, label] of options) s.append(el("option", { value: v, textContent: label }));
  s.value = value ?? "";
  return s;
}

function td(label, ...children) {
  return el("td", label ? { "data-label": label } : {}, ...children);
}

function table(headers, rows) {
  const head = el("tr", {}, ...headers.map((h) => el("th", { textContent: h })));
  return el("table", { className: "hh-table" }, el("thead", {}, head), el("tbody", {}, ...rows));
}

function msgBox() {
  return el("div", { className: "hh-msg", hidden: true });
}

function show(box, text, isError) {
  box.textContent = text;
  box.className = isError ? "hh-msg err" : "hh-msg";
  box.hidden = !text;
}

async function saveFile(file, content, box, button) {
  button.disabled = true;
  show(box, "saving…", false);
  try {
    await client.householdSave(serverId, file, JSON.stringify(content), household.versions[file], CLIENT_VERSION);
    await openHousehold(`Saved ${file}.json.`);
  } catch (e) {
    button.disabled = false;
    show(box, errText(e), true);
  }
}

function renderHousehold(message, isError) {
  const v = household;
  const people = Array.isArray(v.people?.people) ? v.people.people : [];
  const wrap = el("div", { className: "hh-wrap" });
  const close = el("button", { type: "button", textContent: "✕", onclick: () => { householdEl.hidden = true; } });
  close.setAttribute("aria-label", "Close");
  const reload = el("button", { type: "button", className: "quiet", textContent: "Reload", onclick: () => openHousehold() });
  wrap.append(el("div", { className: "list-head" }, el("h2", { textContent: "Household" }), reload, close));
  const top = msgBox();
  show(top, [message, v.note].filter(Boolean).join("\n"), isError || (!message && !!v.note));
  wrap.append(top);

  // ---- People and devices: one file, people.json, saved together.
  const personOptions = () => [["", "nobody"], ...peopleRows.map((r) => [r.id.value.trim(), r.id.value.trim()]).filter(([id]) => id)];
  const peopleRows = [];
  const peopleBody = el("tbody");
  const addPerson = (p = { id: "", name: "", role: "" }) => {
    const row = {
      id: el("input", { value: p.id ?? "", placeholder: "id" }),
      name: el("input", { value: p.name ?? "", placeholder: "name" }),
      role: select(v.choices.roles.map((r) => [r, r]), p.role),
    };
    row.id.addEventListener("change", refreshPersonSelects);
    const remove = el("button", { type: "button", className: "quiet", textContent: "Remove" });
    const tr = el("tr", {}, td("Id", row.id), td("Name", row.name), td("Role", row.role), td("", remove));
    remove.onclick = () => { peopleRows.splice(peopleRows.indexOf(row), 1); tr.remove(); refreshPersonSelects(); };
    peopleRows.push(row);
    peopleBody.append(tr);
  };
  people.forEach((p) => addPerson(p));
  const peopleTable = table(["Id", "Name", "Role", ""], []);
  peopleTable.replaceChild(peopleBody, peopleTable.tBodies[0]);
  const desktop = select(personOptions(), v.people?.desktop);
  const personSelects = [desktop];
  function refreshPersonSelects() {
    for (const s of personSelects) {
      const keep = s.value;
      s.replaceChildren(...personOptions().map(([val, label]) => el("option", { value: val, textContent: label })));
      s.value = keep;
    }
  }

  const devices = [...v.devices].sort((a, b) => (a.name ?? "~").localeCompare(b.name ?? "~"));
  const deviceRows = devices.map((d) => {
    const who = select(personOptions(), d.person);
    personSelects.push(who);
    const revoke = el("button", { type: "button", className: "quiet", textContent: "Revoke" });
    revoke.onclick = () => revokeDevice(d, revoke, peopleBox);
    const seen = d.paired ? (d.lastSeen ? `last seen ${d.lastSeen}` : "paired") : "not paired";
    const tr = el("tr", {},
      td("Device", d.name ?? "(not in the allowlist)"),
      td("Id", el("code", { textContent: `${d.id.slice(0, 10)}…`, title: d.id })),
      td("Status", seen),
      td("Person", who),
      td("", revoke));
    return { d, who, tr };
  });

  const peopleBox = msgBox();
  const savePeople = el("button", { type: "button", textContent: "Save people and devices" });
  savePeople.onclick = () => {
    const content = {
      people: peopleRows.map((r) => ({ id: r.id.value.trim(), name: r.name.value.trim(), role: r.role.value })),
      devices: Object.fromEntries(deviceRows.filter((r) => r.who.value).map((r) => [r.d.id, r.who.value])),
    };
    if (desktop.value) content.desktop = desktop.value;
    saveFile("people", content, peopleBox, savePeople);
  };
  wrap.append(el("section", { className: "hh-section" },
    el("h3", { textContent: "People" }),
    peopleTable,
    el("div", { className: "hh-actions" },
      el("button", { type: "button", className: "quiet", textContent: "Add person", onclick: () => addPerson() }),
      el("label", { className: "hh-inline" }, "This desktop is ", desktop)),
  ));
  wrap.append(el("section", { className: "hh-section" },
    el("h3", { textContent: "Devices" }),
    table(["Device", "Id", "Status", "Person", ""], deviceRows.map((r) => r.tr)),
    el("div", { className: "hh-actions" }, savePeople),
    peopleBox,
  ));

  // ---- Policies: one row per role, then one per (saved) person.
  const pol = v.policies ?? {};
  const policyRows = [
    ...v.choices.roles.map((r) => ({ kind: "roles", key: r, label: `role: ${r}`, p: pol.roles?.[r] ?? {} })),
    ...people.map((p) => ({ kind: "people", key: p.id, label: `${p.name} (${p.id})`, p: pol.people?.[p.id] ?? {} })),
  ];
  const tristate = (val) => select([["", "inherit"], ["true", "yes"], ["false", "no"]], val === undefined || val === null ? "" : String(val));
  const built = policyRows.map((r) => {
    const denied = Array.isArray(r.p.deny_tools) ? r.p.deny_tools : null;
    // Tools the desktop offers, plus any already denied that it doesn't
    // (so a save never silently drops one).
    const names = [...v.choices.tools, ...(denied ?? []).filter((t) => !v.choices.tools.includes(t))];
    const inherit = el("input", { type: "checkbox", checked: denied === null });
    const boxes = names.map((t) => el("input", { type: "checkbox", value: t, checked: !!denied?.includes(t), disabled: denied === null }));
    inherit.onchange = () => boxes.forEach((b) => { b.disabled = inherit.checked; });
    const tools = el("div", { className: "hh-tools" },
      el("label", {}, inherit, "inherit"),
      ...boxes.map((b) => el("label", {}, b, b.value)));
    const f = {
      inherit, boxes,
      start: el("input", { type: "time", value: r.p.quiet_hours?.start ?? "" }),
      end: el("input", { type: "time", value: r.p.quiet_hours?.end ?? "" }),
      reply: el("input", { value: r.p.quiet_reply ?? "", placeholder: "quiet reply" }),
      history: select([["", "inherit"], ...v.choices.history.map((h) => [h, h])], r.p.history ?? ""),
      recall: tristate(r.p.recall),
      hot: tristate(r.p.hot),
    };
    const tr = el("tr", {},
      td("Who", r.label), td("Denied tools", tools),
      td("Quiet from", f.start), td("Quiet until", f.end), td("Quiet reply", f.reply),
      td("History", f.history), td("Recall", f.recall), td("Kept close", f.hot));
    return { r, f, tr };
  });
  const policiesBox = msgBox();
  const savePolicies = el("button", { type: "button", textContent: "Save policies" });
  savePolicies.onclick = () => {
    const content = { roles: {}, people: {} };
    for (const { r, f } of built) {
      const p = {};
      if (!f.inherit.checked) p.deny_tools = f.boxes.filter((b) => b.checked).map((b) => b.value);
      if (f.start.value || f.end.value) {
        p.quiet_hours = {};
        if (f.start.value) p.quiet_hours.start = f.start.value;
        if (f.end.value) p.quiet_hours.end = f.end.value;
      }
      if (f.reply.value.trim()) p.quiet_reply = f.reply.value.trim();
      if (f.history.value) p.history = f.history.value;
      if (f.recall.value) p.recall = f.recall.value === "true";
      if (f.hot.value) p.hot = f.hot.value === "true";
      if (Object.keys(p).length) content[r.kind][r.key] = p;
    }
    saveFile("policies", content, policiesBox, savePolicies);
  };
  wrap.append(el("section", { className: "hh-section" },
    el("h3", { textContent: "Policies" }),
    table(["Who", "Denied tools", "Quiet from", "Quiet until", "Quiet reply", "History", "Recall", "Kept close"], built.map((b) => b.tr)),
    el("div", { className: "hh-actions" }, savePolicies),
    policiesBox,
  ));

  householdEl.replaceChildren(wrap);
}

async function revokeDevice(d, button, box) {
  const label = d.name ?? `${d.id.slice(0, 10)}…`;
  if (!window.confirm(`Revoke ${label}? It won't be able to connect, and it stops counting as anyone.`)) return;
  button.disabled = true;
  try {
    await client.revokeDevice(serverId, d.id, CLIENT_VERSION);
    await openHousehold(`Revoked ${label}.`);
  } catch (e) {
    button.disabled = false;
    show(box, errText(e), true);
  }
}
