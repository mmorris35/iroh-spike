import init, { SpikeNode } from "./wasm/iroh_spike.js";

const banner = document.getElementById("banner");
const detail = document.getElementById("detail");
const logEl = document.getElementById("log");
const msgEl = document.getElementById("msg");
const sendBtn = document.getElementById("send");
const nodeIdEl = document.getElementById("nodeid");

function log(line) {
  const ts = new Date().toISOString().slice(11, 19);
  logEl.textContent += `[${ts}] ${line}\n`;
  console.log(line);
}

function setBanner(cls, text, detailText) {
  banner.className = cls;
  banner.childNodes[0].textContent = text;
  detail.textContent = detailText || "";
}

function targetNodeId() {
  const p = new URLSearchParams(location.search);
  return p.get("node") || (location.hash ? location.hash.slice(1) : "");
}

let node = null;

async function main() {
  const target = targetNodeId();
  if (!target) {
    setBanner("bad", "NO TARGET", "URL is missing ?node=<endpoint-id>. Use the link the server printed.");
    return;
  }
  try {
    setBanner("busy", "LOADING WASM…");
    log("initialising wasm module…");
    await init();
    log("wasm initialised OK");
    setBanner("busy", "STARTING IROH NODE…");
    node = await SpikeNode.spawn();
    const myId = node.endpoint_id();
    nodeIdEl.textContent = `this browser's endpoint id: ${myId}\ntarget desktop: ${target}`;
    log(`local iroh node up: ${myId}`);
    setBanner("", "READY — type a word and press Send");
    sendBtn.disabled = false;
    // Headless test hook: ?auto=<msg> auto-sends and reports outcome via a
    // fetch the local dev server logs. Harmless in normal use.
    const auto = new URLSearchParams(location.search).get("auto");
    if (auto) {
      msgEl.value = auto;
      send();
    }
  } catch (e) {
    setBanner("bad", "FAILED TO START", String(e));
    log(`startup error: ${e}`);
  }
}

async function send() {
  const text = msgEl.value.trim() || "hello from phone";
  sendBtn.disabled = true;
  setBanner("busy", "CONNECTING…", "phone → relay → desktop");
  log(`connecting to desktop, payload: "${text}"`);
  const started = performance.now();
  let gotReply = false;
  try {
    const stream = node.connect(targetNodeId(), text);
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const ev = value;
      if (ev.type === "connected") {
        log(`connected. path: ${ev.path}`);
        setBanner("busy", "CONNECTED — sending…", `path: ${ev.path}`);
      } else if (ev.type === "sent") {
        log(`sent ${ev.bytesSent} bytes`);
      } else if (ev.type === "received") {
        gotReply = true;
        const ms = Math.round(performance.now() - started);
        log(`reply received in ${ms}ms:\n${ev.text}`);
        setBanner("ok", "✅ IT WORKS", `round trip ${ms}ms\n\n${ev.text}`);
      } else if (ev.type === "closed") {
        if (ev.error && !gotReply) {
          log(`connection closed with error: ${ev.error}`);
          setBanner("bad", "❌ FAILED", ev.error);
        } else {
          log("connection closed cleanly");
        }
      }
    }
  } catch (e) {
    log(`error: ${e}`);
    if (!gotReply) setBanner("bad", "❌ FAILED", String(e));
  } finally {
    sendBtn.disabled = false;
    if (new URLSearchParams(location.search).get("auto")) {
      fetch(`./__spike_result__ok=${gotReply ? 1 : 0}`).catch(() => {});
    }
  }
}

sendBtn.addEventListener("click", send);
msgEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !sendBtn.disabled) send(); });
main();
