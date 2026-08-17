/*
 * Hearth phone client logic.
 *
 * Owns: chat rendering, per-desktop history in localStorage, and driving the
 * wasm iroh client. It does NOT own conversation memory — the desktop does.
 * localStorage here is display cache only; clearing it loses nothing the
 * agent knows.
 *
 * Message flow: send() calls HearthClient.send(serverId, text), which returns
 * a ReadableStream of progress events from Rust
 * ({type: connected|sent|received|closed}). We render status transitions from
 * those events; "received" carries the agent's reply (or an agent-side error,
 * so "the model broke" looks different from "desktop unreachable" — R3.6).
 *
 * Test hook: ?auto=<message> auto-sends once after load and then fetches
 * ./__hearth_result__ok=<0|1>&reply=... — a 404 the serving http server logs,
 * which lets a headless-browser test read the outcome from the server log.
 * Harmless in production (the fetch just 404s).
 */
import init, { HearthClient } from "./wasm/hearth.js";

const chatEl = document.getElementById("chat");
const statusEl = document.getElementById("status");
const msgEl = document.getElementById("msg");
const sendBtn = document.getElementById("send");
const form = document.getElementById("composer");

/* The desktop's endpoint id: fragment preferred, ?node= accepted for
 * compatibility with the spike's URL shape. */
const serverId =
  (location.hash ? location.hash.slice(1) : "") ||
  new URLSearchParams(location.search).get("node") ||
  "";

const HISTORY_KEY = `hearth-history-${serverId}`;
let history = [];
try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { /* corrupt cache */ }

let client = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "err" : "";
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

function saveHistory(role, text) {
  history.push({ role, text });
  // Cap the display cache; the desktop holds the real transcript.
  if (history.length > 200) history = history.slice(-200);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* quota */ }
}

async function main() {
  if (!serverId) {
    setStatus("no desktop id in URL", true);
    addBubble("agent", "This link is missing the desktop's id. Open the exact link (or QR) that hearth-desktop printed — it ends with #<endpoint-id>.", "error");
    return;
  }
  for (const m of history) addBubble(m.role, m.text);
  try {
    setStatus("loading…");
    await init();
    setStatus("starting iroh…");
    client = await HearthClient.spawn();
    setStatus("ready");
    sendBtn.disabled = false;
    msgEl.focus();

    const auto = new URLSearchParams(location.search).get("auto");
    if (auto) { msgEl.value = auto; send(true); }
  } catch (e) {
    setStatus("failed to start", true);
    addBubble("agent", `Could not start: ${e}`, "error");
  }
}

async function send(isAuto = false) {
  const text = msgEl.value.trim();
  if (!text || sendBtn.disabled) return;
  msgEl.value = "";
  sendBtn.disabled = true;
  addBubble("user", text);
  saveHistory("user", text);
  const pending = addBubble("agent", "…", "pending");

  let outcome = { ok: false, reply: "" };
  try {
    setStatus("connecting…");
    const stream = client.send(serverId, text);
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
        if (ev.error) {
          // The desktop answered but the agent failed (model down, etc.).
          addBubble("agent", `Agent error: ${ev.error}`, "error");
          setStatus("agent error", true);
        } else {
          addBubble("agent", ev.reply);
          saveHistory("agent", ev.reply);
          setStatus("ready");
          outcome = { ok: true, reply: ev.reply };
        }
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
    sendBtn.disabled = false;
    if (isAuto) {
      const q = `ok=${outcome.ok ? 1 : 0}&reply=${encodeURIComponent(outcome.reply.slice(0, 200))}`;
      fetch(`./__hearth_result__${q}`).catch(() => {});
    }
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
main();

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
