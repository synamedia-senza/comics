//
//  book.js
//
//
//  Created by andrewzc on 1/17/26.
//


function getParam(name, def = null) {
  const u = new URL(window.location.href);
  const v = u.searchParams.get(name);
  return (v === null || v === "") ? def : v;
}

const video = getParam("video", "bbb");
const style = getParam("style", "tintin");

// How far to scan for existing frames.
// You can override via ?max=900 etc.
const maxSeconds = Number.parseInt(getParam("max", "3600"), 10);
const step = 15;

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Convert bucket seconds -> "mm-ss" (e.g. 75 -> "01-15")
function secondsToKey(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${pad2(mm)}-${pad2(ss)}`;
}

// Convert "mm-ss" -> "mm:ss" for display
function keyToDisplay(key) {
  return String(key).replace("-", ":");
}

const apiBase = ""; // "" => current origin

const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");
const subEl = document.getElementById("sub");
const emptyEl = document.getElementById("empty");

subEl.textContent = `video=${video}  style=${style}  (scan 00:00..${keyToDisplay(secondsToKey(maxSeconds))} step=${step}s)`;

function panelUrl(key) {
  // Use the backend's stable URL (from GET response), but add cache-buster for dev viewing
  // so CloudFront/browser doesn't keep showing deleted/old content.
  return `${apiBase}/comics/${encodeURIComponent(video)}/${encodeURIComponent(style)}/${encodeURIComponent(key)}`;
}

async function getStatus(key) {
  const r = await fetch(panelUrl(key), { method: "GET", cache: "no-store" });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { http: r.status, body };
}

async function deletePanel(key) {
  const r = await fetch(panelUrl(key), { method: "DELETE" });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  if (!r.ok) {
    throw new Error(body?.message || `Delete failed (${r.status})`);
  }
  return body;
}

function createTile(key, imgUrl) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.t = String(key);

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = keyToDisplay(key);

  const btn = document.createElement("button");
  btn.className = "delete";
  btn.title = "Delete panel";
  btn.textContent = "×";

  const inner = document.createElement("div");
  inner.className = "inner";

  const img = document.createElement("img");
  // cache bust for viewing so you always see latest after overwrite/regeneration
  img.src = `${imgUrl}?v=${Date.now()}`;
  img.alt = `${video}/${style}/${key}`;

  inner.appendChild(img);
  tile.appendChild(inner);
  tile.appendChild(badge);
  tile.appendChild(btn);

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const ok = confirm(`Delete panel ${video}/${style}/${keyToDisplay(key)}?`);
    if (!ok) return;

    // Optimistic UI
    tile.remove();

    try {
      await deletePanel(key);
      updateCounts();
    } catch (e) {
      alert(String(e?.message || e));
      // If delete failed, re-add tile so you don't lose track
      grid.appendChild(tile);
      updateCounts();
    }
  });

  return tile;
}

// Simple concurrency limiter
async function mapWithConcurrency(items, limit, fn) {
  const out = [];
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }

  const workers = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

function updateCounts() {
  const n = grid.querySelectorAll(".tile").length;
  statusEl.textContent = `Showing ${n} panel${n === 1 ? "" : "s"}`;
  emptyEl.style.display = n === 0 ? "inline-block" : "none";
}

function compareKeys(a, b) {
  // Keys are canonical "MM-SS" so lexicographic compare is sufficient.
  return String(a).localeCompare(String(b));
}

function insertTileSorted(tile) {
  const key = tile.dataset.t;
  const children = Array.from(grid.children);
  for (const child of children) {
    const ck = child.dataset.t;
    if (compareKeys(key, ck) < 0) {
      grid.insertBefore(tile, child);
      return;
    }
  }
  grid.appendChild(tile);
}

async function main() {
  const buckets = [];
  for (let t = 0; t <= maxSeconds; t += step) buckets.push(secondsToKey(t));

  statusEl.textContent = `Scanning ${buckets.length} buckets…`;

  let found = 0;
  let scanned = 0;

  await mapWithConcurrency(buckets, 8, async (key) => {
    const s = await getStatus(key);
    scanned++;

    if (s.http === 200 && s.body?.status === "ready" && s.body?.url) {
      found++;
      const tile = createTile(key, s.body.url);
      insertTileSorted(tile);
    }

    if (scanned % 10 === 0) {
      statusEl.textContent = `Scanned ${scanned}/${buckets.length}… found ${found} (last=${keyToDisplay(key)})`;
    }
  });

  updateCounts();
}

main().catch((e) => {
  console.error(e);
  statusEl.textContent = `Error: ${String(e?.message || e)}`;
});
