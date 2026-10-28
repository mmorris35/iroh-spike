/* How a file the agent attached is shown on the phone.
 *
 * The page's origin holds the device key, so nothing the agent sends may run
 * script here (Bilby's review of #79, B2). A model can label a file anything,
 * and an SVG or HTML file opened from a blob: URL runs with this origin. So:
 *
 *   - The type is judged from the file's first bytes, never from the label the
 *     desktop passes along (which itself is judged from the bytes since #79's
 *     revision, but a phone must not depend on a desktop being current).
 *   - Only PNG, JPEG, GIF, WebP and PDF are ever shown or opened: an image
 *     previews inline, a PDF opens in the browser's viewer.
 *   - Everything else is download only: its Blob is application/octet-stream
 *     and its link carries `download` and never `target`, so the browser saves
 *     it rather than rendering it in this origin.
 *
 * The same allow-list and signatures as `attachments::served_type` in
 * src/attachments.rs. Kept free of the wasm client so
 * scripts/verify-file-types.mjs can drive it in a real browser. */

export const PREVIEWABLE = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

const DOWNLOAD_ONLY = "application/octet-stream";

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

const ascii = (text) => Array.from(text, (ch) => ch.charCodeAt(0));

/* One of PREVIEWABLE when the bytes start with that format's signature,
 * otherwise application/octet-stream. */
export function sniffType(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes.subarray(8), ascii("WEBP"))) return "image/webp";
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  return DOWNLOAD_ONLY;
}

/* A fetched file ready to show: `{name, mime, url}`, where `mime` is what the
 * bytes are (or download-only) and `url` an object URL of a Blob of exactly
 * that type. `claimedMime` is accepted and deliberately ignored. */
export function prepareFile(name, data, claimedMime) {
  void claimedMime;
  const mime = sniffType(data);
  return { name, mime, url: URL.createObjectURL(new Blob([data], { type: mime })) };
}

/* Show a prepared file in `card`, the box under the reply, replacing `btn`
 * (the "Open" button). Returns what it did: "image", "pdf" or "download". */
export function presentFile(card, btn, got) {
  const doc = card.ownerDocument;
  const kind = got.mime === "application/pdf" ? "pdf" : PREVIEWABLE.includes(got.mime) ? "image" : "download";
  if (kind === "image" && !card.querySelector("img")) {
    const img = doc.createElement("img");
    img.className = "file-preview";
    img.alt = got.name;
    img.src = got.url;
    card.appendChild(img);
  }
  const link = doc.createElement("a");
  link.href = got.url;
  link.rel = "noopener";
  link.className = "file-link";
  if (kind === "pdf") {
    link.target = "_blank";
    link.textContent = `Open ${got.name}`;
  } else {
    link.download = got.name;
    link.textContent = `Save ${got.name}`;
  }
  card.querySelector(".file-link")?.remove();
  card.appendChild(link);
  // An image is already on screen; a PDF opens and anything else saves at once.
  if (kind !== "image") link.click();
  btn.hidden = true;
  return kind;
}
