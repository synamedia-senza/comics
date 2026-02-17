const videos = {
  "bbb": "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
  "elephant": "https://rdmedia.bbc.co.uk/elephants_dream/1/client_manifest-all.mpd",
  "sintel": "https://storage.googleapis.com/shaka-demo-assets/sintel/dash.mpd",
  "tears": "https://ftp.itec.aau.at/datasets/DASHDataset2014/TearsOfSteel/4sec/TearsOfSteel_4s_simple_2014_05_09.mpd"
}

const keyframes = {
  "bbb": ["00:03", "00:21", "00:35", "00:51", "01:07", "01:21", "01:44", "01:55", "02:03"]
};

let player;
let videoId;
let styleId;
let videoEl;
let liveTimecodeEl;

// Buckets (15s intervals) where the user (or automation) has already triggered an Enter-style generation.
// Stored as the bucket start in seconds (e.g. 0, 15, 30, ...)
let enterBuckets = new Set();

// Track which mm:ss keyframe timestamps have already fired during this playback session
let firedAutoKeyframes = new Set();

// Last 15s bucket we attempted (prevents repeat triggers while time stays in same bucket)
let lastBucket = null;

// index of timecode to image links, i.e.
// "00-30": "https://senzadev.net/comics/bbb/tintin/00-30.jpg"
let comics = {};
// key -> version timestamp (used for cache-busting only when the image changes)
let comicsVersion = {};

// key -> true while a job is in progress (prevents duplicate POSTs)
let inFlight = {};


let availableKeys = new Set(); // mm-ss keys with known URLs

// mm-ss keys currently generating (we show a blurred/darkened input-frame placeholder)
let pendingKeys = new Set();
// key -> placeholder data URL
let placeholders = {};
// key -> version timestamp for placeholder cache busting
let placeholderVersion = {};

function upsertAvailable(key, url) {
  if (!key || !url) return;
  const kk = String(key);
  comics[kk] = url;
  comicsVersion[kk] = Date.now();
  availableKeys.add(kk);

  // Clear placeholder/pending state once we have the real image.
  pendingKeys.delete(kk);
  delete placeholders[kk];
  delete placeholderVersion[kk];
}


function getSortedDisplayKeys() {
  const all = new Set([...availableKeys, ...pendingKeys]);
  return Array.from(all).sort(compareKeys);
}

function getSortedAvailableKeys() {
  return Array.from(availableKeys).sort(compareKeys);
}

function mostRecentAvailableAtOrBefore(targetKey) {
  const keys = getSortedDisplayKeys();
  let best = null;
  for (const k of keys) {
    if (compareKeys(k, targetKey) <= 0) best = k;
    else break;
  }
  return best;
}

function getWindowKeys(currentTimeSeconds) {
  const keys = getSortedDisplayKeys();
  if (keys.length === 0) return { keys: [], leftAlign: true };

  const target = nextBucketKey(currentTimeSeconds);
  const anchor = (availableKeys.has(target)) ? target : (mostRecentAvailableAtOrBefore(target) || keys[keys.length - 1]);

  // Build window ending at anchor (rightmost), skipping missing.
  const window = [];
  for (let i = keys.length - 1; i >= 0 && window.length < 6; i--) {
    const k = keys[i];
    if (compareKeys(k, anchor) > 0) continue;
    window.unshift(k);
  }

  // If we have fewer than 6 and we're early in the video, show left-aligned build-up.
  if (window.length < 6 && compareKeys(anchor, "01-30") <= 0) {
    // early build-up: show first N keys from start (left-aligned)
    return { keys: keys.slice(0, Math.min(6, keys.length)), leftAlign: true };
  }

  return { keys: window, leftAlign: false };
}

let lastRenderedSig = null; // signature including slot keys + versions (prevents "ready but not rendered" issues)
let lastRenderedCurrentKey = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Prefetch existing panels starting from 00-00 so the strip can render immediately.
// We scan in 15s steps and stop once we have at least 6 panels found, or we reach the
// end of the video (when duration is known), or we hit a reasonable hard cap.
async function prefetchAvailablePanels() {
  // Wait for metadata so duration is available (but don't block forever).
  for (let i = 0; i < 50; i++) {
    if (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) break;
    await sleep(100);
  }

  const duration = (videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0)
    ? videoEl.duration
    : 60 * 10; // fallback: scan first 10 minutes

  const hardCapSeconds = Math.min(duration, 60 * 60); // never scan more than 1 hour on load

  let found = 0;
  for (let t = 0; t <= hardCapSeconds; t += 15) {
    const key = secondsToKey(t);
    const res = await getComicStatus(videoId, styleId, key);
    if (res.http === 200 && res.body?.status === "ready" && res.body?.url) {
      found++;
      // As soon as we find something, render so the user sees progress immediately.
      renderStrip();
      if (found >= 6) break;
    }
    // Small delay to avoid hammering the backend on startup.
    await sleep(40);
  }

  // If we found nothing, ensure the strip is hidden.
  renderStrip();
}

function renderStrip() {
  const strip = document.getElementById("comicStrip");
  if (!strip) return;

  // Hide the strip entirely until we have at least one panel (real or placeholder) to show.
  if (availableKeys.size === 0 && pendingKeys.size === 0) {
    strip.style.display = "none";
    lastRenderedSig = null;
    lastRenderedCurrentKey = null;
    return;
  }
  strip.style.display = "grid";

  const time = videoEl ? videoEl.currentTime : 0;
  const win = getWindowKeys(time);
  const windowKeys = win.keys;
  const leftAlign = !!win.leftAlign;

  // Ensure exactly 6 slots
  const slots = [];
  const pad = 6 - windowKeys.length;
  if (leftAlign) {
    for (const k of windowKeys) slots.push(k);
    for (let i = 0; i < pad; i++) slots.push(null);
  } else {
    for (let i = 0; i < pad; i++) slots.push(null);
    for (const k of windowKeys) slots.push(k);
  }

  // Current highlight: highlight the panel for the *start* of the current 15s interval.
  // Example: from 00:00 up to (but not including) 00:15, highlight 00-00.
  // From 00:15 up to 00:30, highlight 00-15, etc.
  const currentBucketSeconds = Math.max(0, Math.floor(time / 15) * 15);
  const currentKey = secondsToKey(currentBucketSeconds);

  // If nothing changed, don't touch DOM (prevents flicker / reload)
  // IMPORTANT: include comicsVersion + ready-state so a panel can appear (url becomes ready)
  // without changing which keys are in the 6 slots.
  const sig = slots.map((k) => {
    if (!k) return "_";
    const kk = String(k);
    const v = comicsVersion[kk] || 0;
    const has = comics[kk] ? 1 : 0;
    const pv = placeholderVersion[kk] || 0;
    const phas = placeholders[kk] ? 1 : 0;
    return `${kk}@${v}@${has}@${pv}@${phas}`;
  }).join("|");

  const sameSig = (lastRenderedSig === sig);
  const sameHighlight = (lastRenderedCurrentKey === currentKey);

  if (sameSig && !sameHighlight) {
    // Only the selected/highlighted bucket changed; update classes in-place.
    const inners = strip.querySelectorAll(".comic-inner");
    inners.forEach((el) => {
      const k = el.dataset.key;
      if (!k) return;
      if (k === currentKey) el.classList.add("current");
      else el.classList.remove("current");
    });
    lastRenderedCurrentKey = currentKey;
    return;
  }

  if (sameSig && sameHighlight) {
    return;
  }

  lastRenderedSig = sig;
  lastRenderedCurrentKey = currentKey;

  strip.innerHTML = "";
  slots.forEach((k, idx) => {
    if (!k) return; // don't render empty tiles; let video show through

    const tile = document.createElement("div");
    tile.className = "comic-tile";

    const inner = document.createElement("div");
    inner.className = "comic-inner" + (k === currentKey ? " current" : "");
    inner.dataset.key = String(k);

    const badge = document.createElement("div");
    badge.className = "comic-badge";
    badge.textContent = k ? keyToDisplay(k) : "";

    inner.appendChild(badge);

    const kk = String(k);

    if (comics[kk]) {
      const img = document.createElement("img");
      const v = comicsVersion[kk] || 0;
      img.src = comics[kk] + (v ? `?v=${v}` : "");
      inner.classList.remove("placeholder");
      inner.appendChild(img);
    } else if (placeholders[kk]) {
      const img = document.createElement("img");
      img.src = placeholders[kk];
      inner.classList.add("placeholder");
      inner.appendChild(img);
    }
    tile.appendChild(inner);
    strip.appendChild(tile);
  });
}

window.addEventListener("load", async () => {
  try {
    await senza.init();
    
    videoId = getParam("video", "bbb");
    styleId = getParam("style", "tintin");

    videoEl = document.getElementById("video");
    liveTimecodeEl = document.getElementById("liveTimecode");

    // Reset per-playback automation state
    enterBuckets = new Set();
    firedAutoKeyframes = new Set();
      
    console.log("Starting comics demo with video=", videoId, "style=", styleId);

    player = new senza.ShakaPlayer();
    player.configure({abr: {restrictions: {maxHeight: 1080}}});
    player.attach(videoEl);
    await player.load(videos[videoId]);
    await videoEl.play();

    senza.lifecycle.configure({autoBackground: {enabled: false}});
    senza.uiReady();
    
    prefetchAvailablePanels().catch(console.error);

    setInterval(() => { makeComics(false).catch(console.error); }, 5000);
    setInterval(updateLiveTimecode, 200);
      
    renderStrip();
    setInterval(() => renderStrip(), 250);
  } catch (error) {
    console.error(error);
  }
});

// Draw the current video frame to an offscreen square canvas (center-cropped).
function drawCurrentFrameToCanvas(size = 512) {
  if (!videoEl) throw new Error("video element not ready");

  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error("video metadata not ready (videoWidth/videoHeight is 0)");

  const side = Math.min(vw, vh);
  const sx = Math.floor((vw - side) / 2);
  const sy = Math.floor((vh - side) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, size, size);
  return canvas;
}

// Create a blurred + darkened placeholder data URL from a square canvas.
function makePlaceholderDataUrl(fromCanvas, blurPx = 18, darkenAlpha = 0.5, quality = 0.82) {
  const w = fromCanvas.width;
  const h = fromCanvas.height;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;

  const ctx = out.getContext("2d");
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(fromCanvas, 0, 0);
  ctx.filter = "none";

  ctx.fillStyle = `rgba(0,0,0,${darkenAlpha})`;
  ctx.fillRect(0, 0, w, h);

  return out.toDataURL("image/jpeg", quality);
}

function upsertPendingPlaceholder(key, dataUrl) {
  if (!key || !dataUrl) return;
  const kk = String(key);
  pendingKeys.add(kk);
  placeholders[kk] = dataUrl;
  placeholderVersion[kk] = Date.now();
}

// Capture the current video frame as a centered square JPEG (fast, small payload).
async function getCurrentVideoFrameBlob(quality = 0.85) {
  if (!videoEl) throw new Error("video element not ready");

  const canvas = document.getElementById("canvas");
  if (!canvas) throw new Error("missing canvas element");

  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error("video metadata not ready (videoWidth/videoHeight is 0)");

  // Center square crop
  const side = Math.min(vw, vh);
  const sx = Math.floor((vw - side) / 2);
  const sy = Math.floor((vh - side) / 2);

  // Capture at 1024x1024 (matches server-side generation size; still small enough for demos)
  canvas.width = 1024;
  canvas.height = 1024;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, 1024, 1024);

  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

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

function keyToDisplay(key) {
  return String(key).replace("-", ":");
}

function nextBucketKey(timeSeconds) {
  const t = Math.max(0, timeSeconds);
  const next = (Math.floor(t / 15) + 1) * 15;
  return secondsToKey(next);
}

function compareKeys(a, b) {
  return String(a).localeCompare(String(b));
}

// Convert "mm-ss" -> seconds (e.g. "01-15" -> 75). Returns null if invalid.
function keyToSeconds(key) {
  const m = /^\s*(\d{2})-(\d{2})\s*$/.exec(String(key));
  if (!m) return null;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss > 59) return null;
  return mm * 60 + ss;
}

function apiPath(video, style, t) {
  const key = (typeof t === "string") ? t : secondsToKey(t);
  return `/comics/${encodeURIComponent(video)}/${encodeURIComponent(style)}/${encodeURIComponent(key)}`;
}

async function getComicStatus(video, style, key) {
  const url = apiPath(video, style, key);
  const r = await fetch(url, { method: "GET" });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  if (r.status === 200 && body?.status === "ready" && body?.url && key) {
    upsertAvailable(key, body.url);
  }
  return { http: r.status, body };
}

async function makeComics(force) {
  if (!videoEl) return;

  const time = videoEl.currentTime;
  if (!Number.isFinite(time) || time < 0) return;

  // Decide which 15s bucket to target.
  // - Automatic mode (force=false): generate once when we ENTER a new 15s bucket.
  //   (No "near boundary" heuristic; those can miss buckets depending on timer cadence.)
  // - Interactive mode (force=true via Enter): generate early for the *next* bucket.
  let bucketSeconds;
  if (force) {
    bucketSeconds = (Math.floor(time / 15) + 1) * 15; // round up to next bucket
  } else {
    bucketSeconds = Math.floor(time / 15) * 15; // current bucket
  }

  const key = secondsToKey(bucketSeconds);

  // Don't auto-generate 00:00 — it's often a title card / empty establishing frame.
  // If the user presses Enter early (e.g. at 00:04), we still generate the next bucket (00:15).
  if (!force && bucketSeconds === 0) {
    lastBucket = bucketSeconds; // prevent repeated triggers while in the 00:00 bucket
    return;
  }

  // Avoid repeat work for the same bucket, unless forced.
  if (!force && bucketSeconds === lastBucket) return;

  lastBucket = bucketSeconds;

  const tag = force ? "[comics] ENTER" : "[comics] keyframe";
  console.log(`${tag} bucket=`, key, "(sec=", bucketSeconds, ") time=", time.toFixed(2));
  await ensureComicPanel(videoId, styleId, key, force);
}

async function startComicGeneration(video, style, key, forceOverwrite = false) {
  const url = apiPath(video, style, key);
  const blob = await getCurrentVideoFrameBlob(0.85);
  if (!blob) throw new Error("Failed to capture frame blob");

  console.log("[comics] POST start generation", { video, style, key, bytes: blob.size });

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "image/jpeg",
      ...(forceOverwrite ? { "X-Force-Overwrite": "1" } : {})
    },
    body: blob
  });

  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { http: r.status, body };
}

async function ensureComicPanel(video, style, key, forceOverwrite = false) {
  const jobKey = `${video}/${style}/${key}`;
  if (!forceOverwrite && comics[String(key)]) {
    console.log("[comics] already have url for key=", key);
    availableKeys.add(String(key));
    renderStrip();
    return comics[String(key)];
  }
  if (inFlight[jobKey]) {
    console.log("[comics] already in-flight:", jobKey);
    return null;
  }

  inFlight[jobKey] = true;
  try {
    // 1) Check status
    let status = await getComicStatus(video, style, key);
    if (status.http === 200 && status.body?.status === "ready" && status.body?.url) {
      console.log("[comics] READY (cache)", key, status.body.url);
      upsertAvailable(key, status.body.url);
      renderStrip();
      if (!forceOverwrite) {
        return status.body.url;
      }
      console.log("[comics] force overwrite requested; regenerating", key);
    }

    // 2) Start generation
    // - Normal mode: only if missing
    // - Force overwrite: always (even if ready)
    if (forceOverwrite || status.http === 404 || status.body?.status === "missing") {
      // Show placeholder immediately so the UI feels responsive.
        try {
            const frameCanvas = drawCurrentFrameToCanvas(512);
            const ph = makePlaceholderDataUrl(frameCanvas, 18, 0.5, 0.82);
            upsertPendingPlaceholder(key, ph);
            renderStrip();
      } catch (e) {
        console.log("[comics] placeholder capture failed", e);
      }

      status = await startComicGeneration(video, style, key, forceOverwrite);
    }

    // 3) Poll until ready/error
    let attempts = 0;
    while (attempts < 30) { // up to ~150 seconds
      attempts++;

      const poll = await getComicStatus(video, style, key);
      if (poll.http === 200 && poll.body?.status === "ready" && poll.body?.url) {
        console.log("[comics] READY", key, poll.body.url);
        upsertAvailable(key, poll.body.url);
        // (Defensive) Clear pending state.
        pendingKeys.delete(String(key));
        delete placeholders[String(key)];
        delete placeholderVersion[String(key)];
        renderStrip();
        return poll.body.url;
      }

      if (poll.http >= 500 || poll.body?.status === "error") {
        console.log("[comics] ERROR", key, poll.body);
        return null;
      }

      // generating / still missing
      if (attempts % 2 === 0) {
        console.log("[comics] waiting...", { key, http: poll.http, status: poll.body?.status, attempts });
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    console.log("[comics] TIMEOUT waiting for", key);
    return null;
  } finally {
    delete inFlight[jobKey];
  }
}

document.addEventListener("keydown", async function (event) {
  switch (event.key) {
    case "Enter":
      // Record that the user manually triggered generation in this 15s interval.
      if (videoEl) {
        const bucketSeconds = Math.floor(Math.max(0, videoEl.currentTime) / 15) * 15;
        enterBuckets.add(bucketSeconds);
      }
      await makeComics(true);
      break;
    case "Escape": await playPause(); break;
    case "ArrowUp": break;
    case "ArrowDown": break;
    case "ArrowLeft": await skip(-15); break;
    case "ArrowRight": await skip(15); break;
    default: return;
  }
  event.preventDefault();
});

async function playPause() {
  if (!videoEl) return;
  if (videoEl.paused) {
    // If replaying from the start, allow auto keyframes to fire again.
    if (videoEl.currentTime < 0.5) {
      enterBuckets = new Set();
      firedAutoKeyframes = new Set();
    }
    await videoEl.play();
  } else {
    await videoEl.pause();
  }
}

// Seek by +/- seconds and land exactly on a 15-second bucket.
async function skip(seconds) {
  if (!videoEl) return;
  const target = videoEl.currentTime + seconds;
  videoEl.currentTime = Math.floor(target / 15) * 15;

  // Skipping around should allow re-triggering keyframes in the new region.
  enterBuckets = new Set();
  firedAutoKeyframes = new Set();

  // Force the comics loop to consider the new bucket immediately
  lastBucket = null;
  lastRenderedSig = null;
  console.log("[comics] skip to", videoEl.currentTime);
  renderStrip();
}

function formatMmSs(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${pad2(mm)}:${pad2(ss)}`;
}

function updateLiveTimecode() {
  if (!videoEl || !liveTimecodeEl) return;

  const now = videoEl.currentTime;
  const stamp = formatMmSs(now);
  liveTimecodeEl.textContent = stamp;

  // Auto-trigger best-known keyframes for specific videos.
  const list = keyframes[videoId] || [];
  if (list.length === 0) return;

  // Only trigger once per listed timestamp per playback session.
  if (!list.includes(stamp) || firedAutoKeyframes.has(stamp)) return;

  // Only auto-trigger if the user hasn't already hit Enter in the current 15s interval.
  const bucketSeconds = Math.floor(Math.max(0, now) / 15) * 15;
  if (enterBuckets.has(bucketSeconds)) {
    firedAutoKeyframes.add(stamp);
    return;
  }

  firedAutoKeyframes.add(stamp);
  enterBuckets.add(bucketSeconds);

  // Simulate pressing Enter: generate for the next 15s bucket.
  makeComics(true).catch(console.error);
}

function getParam(name, defaultValue = null) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.has(name) ? urlParams.get(name) : defaultValue;
}
