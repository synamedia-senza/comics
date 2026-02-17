const express = require("express");
const app = express();
const errorHandler = require('errorhandler');
const dotenv = require("dotenv");
dotenv.config();
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT, 10) || 8080;
const publicDir = process.argv[2] || __dirname + '/public';
const styles = require("./styles.json");
const { OpenAI } = require("openai");
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});
const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

app.use(express.static(publicDir));
app.use(errorHandler({ dumpExceptions: true, showStack: true}));
app.listen(port, () => {
    console.log("Comics server running at " + hostname + ":" + port);
});

// Accept raw image bytes for POST /comics/:video/:style/:tc
app.use(express.raw({
  type: ["image/jpeg", "image/jpg", "image/png", "application/octet-stream"],
  limit: "10mb"
}));

// In-memory job state for demo purposes (keyed by video/style/mm-ss bucket)
const jobs = new Map();
// Job shape: { status: 'generating'|'ready'|'error', url?: string, error?: string, startedAt: number }
const JOB_TTL_MS = 5 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Normalize timecode keys.
// Accepts:
//  - "mm-ss" (preferred)
//  - also tolerates "mm:ss" and normalizes to "mm-ss"
// Returns canonical "MM-SS" string or null.
function normalizeT(tRaw) {
  const raw = String(tRaw ?? "").trim();
  if (!raw) return null;

  // mm-ss
  let m = raw.match(/^(\d{1,3})-(\d{2})$/);
  if (!m) {
    // mm:ss
    m = raw.match(/^(\d{1,3}):(\d{2})$/);
  }
  if (!m) return null;

  const mm = Number(m[1]);
  const ss = Number(m[2]);
  if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  if (mm < 0 || ss < 0 || ss > 59) return null;

  return `${pad2(mm)}-${pad2(ss)}`;
}

function jobKey(video, style, tc) {
  return `${video}:${style}:${tc}`;
}

function getStylePrompt(style) {
  const s = styles?.[style];
  return s?.prompt || null;
}

function buildPrompt(style) {
  const styleText = getStylePrompt(style);
  const prompt = defaultPrompt.replace("$STYLE", styleText || "a comic book style");
  return prompt;
}

function comicsObjectKey(video, style, t) {
  // Ensure exactly one '/' between S3Path and the rest
  const prefix = String(process.env.S3_PATH || "").replace(/\/*$/, "");
  const path = `${video}/${style}/${t}.jpg`;
  return prefix ? `${prefix}/${path}` : path;
}

function comicsUrlForKey(Key) {
  return process.env.BASE_URL ? `${process.env.BASE_URL}/${Key}` : `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${Key}`;
}

async function s3ObjectExists(Key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key }));
    return true;
  } catch (e) {
    // AWS SDK v3 throws on missing keys; treat "NotFound" and 404 as false
    const httpCode = e?.$metadata?.httpStatusCode;
    if (e?.name === "NotFound" || httpCode === 404) return false;
    // For demos, log and treat unknown errors as "not exists" so the API can surface them on generation
    console.log("s3ObjectExists error:", e);
    return false;
  }
}

function cleanupJobs() {
  const now = Date.now();
  for (const [k, job] of jobs.entries()) {
    if (!job?.startedAt || (now - job.startedAt) > JOB_TTL_MS) {
      jobs.delete(k);
    }
  }
}

setInterval(cleanupJobs, 30 * 1000).unref?.();

// GET /styles
// Returns the style definitions loaded from styles.json
app.get("/styles", (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.status(200).json(styles);
});

const defaultPrompt = `Reimagine this frame as ONE comic-book panel.
Style: $STYLE

Redraw the whole scene as NEW comic art (not a filter, not a paint-over).
Keep the same characters + action + camera angle.
Make it legible at 300x300: clear silhouettes, clean shapes, strong contrast.
Clean line art, coherent perspective; no abstract blobs; no unfinished areas.
Square 512x512 composition; center the main subject.
No border around the edge. No text, captions, bubbles, watermarks, or UI overlays.
Ignore and remove any on-screen debug/timestamp/resolution text from the source.
`;

// GET /comics/:video/:style/:tc
// Returns JSON status:
//  - 200 { status:'ready', url }
//  - 202 { status:'generating' }
//  - 404 { status:'missing' }
//  - 500 { status:'error', message }
app.get("/comics/:video/:style/:tc", async (req, res) => {
  try {
    const { video, style, tc: tRaw } = req.params;
    const t = normalizeT(tRaw);
    if (!video || !style || t === null) {
      return res.status(400).json({ status: "error", message: "Invalid parameters" });
    }
    if (!getStylePrompt(style)) {
      return res.status(400).json({ status: "error", message: `Unknown style: ${style}` });
    }

    const k = jobKey(video, style, t);
    const job = jobs.get(k);
    if (job?.status === "generating") {
      res.set("Retry-After", "1");
      return res.status(202).json({ status: "generating" });
    }
    if (job?.status === "error") {
      return res.status(500).json({ status: "error", message: job.error || "Generation failed" });
    }
    if (job?.status === "ready" && job.url) {
      return res.status(200).json({ status: "ready", url: job.url });
    }

    const Key = comicsObjectKey(video, style, t);
    const exists = await s3ObjectExists(Key);
    if (exists) {
      const url = comicsUrlForKey(Key);
      return res.status(200).json({ status: "ready", url });
    }

    return res.status(404).json({ status: "missing" });
  } catch (e) {
    console.log("GET /comics error:", e);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// POST /comics/:video/:style/:tc
// Body: raw image bytes (jpeg/png). Starts an async generation job and returns 202.
app.post("/comics/:video/:style/:tc", async (req, res) => {
  try {
    const { video, style, tc: tRaw } = req.params;
    const t = normalizeT(tRaw);
    if (!video || !style || t === null) {
      return res.status(400).json({ status: "error", message: "Invalid parameters" });
    }
    if (!getStylePrompt(style)) {
      return res.status(400).json({ status: "error", message: `Unknown style: ${style}` });
    }
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ status: "error", message: "Missing image body" });
    }

    const forceOverwrite = req.headers["x-force-overwrite"] === "1";

    const Key = comicsObjectKey(video, style, t);
    // If already exists, return ready immediately (unless force-overwrite was requested)
    const exists = await s3ObjectExists(Key);
    if (exists && !forceOverwrite) {
      const url = comicsUrlForKey(Key);
      return res.status(200).json({ status: "ready", url });
    }
    if (exists && forceOverwrite) {
      console.log(`[comics] overwrite requested for ${video}/${style}/${t}`);
    }

    const k = jobKey(video, style, t);
    const current = jobs.get(k);
    if (current?.status === "generating") {
      // If a job is already running for this key, just report in-progress.
      return res.status(202).json({ status: "generating" });
    }

    // Start job
    if (forceOverwrite) {
      console.log(`[comics] forcing regeneration for ${k}`);
    }
    jobs.set(k, { status: "generating", startedAt: Date.now() });
    res.status(202).json({ status: "generating" });
    console.log(`Generating ${k}`);
      
    // Fire-and-forget generation
    (async () => {
      try {
        const prompt = buildPrompt(style);
        const started = Date.now();
        const url = await generateImageFromFrame(req.body, req.headers["content-type"], prompt, Key);
        const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
        if (!url) {
          jobs.set(k, { status: "error", error: "OpenAI returned no image", startedAt: Date.now() });
          console.log(`[comics] generation failed for ${video}/${style}/${t} after ${elapsedSec}s`);
          return;
        }
        console.log(`${url} - ${elapsedSec}s`);
        jobs.set(k, { status: "ready", url, startedAt: Date.now() });
      } catch (err) {
        console.log("Generation job failed:", err);
        jobs.set(k, { status: "error", error: String(err?.message || err), startedAt: Date.now() });
      }
    })();
  } catch (e) {
    console.log("POST /comics error:", e);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// DELETE /comics/:video/:style/:tc
// Deletes the generated image from S3 so it can be regenerated.
app.delete("/comics/:video/:style/:tc", async (req, res) => {
  try {
    const { video, style, tc: tRaw } = req.params;
    const t = normalizeT(tRaw);
    if (!video || !style || t === null) {
      return res.status(400).json({ status: "error", message: "Invalid parameters" });
    }
    if (!getStylePrompt(style)) {
      return res.status(400).json({ status: "error", message: `Unknown style: ${style}` });
    }

    const Key = comicsObjectKey(video, style, t);

    // Best-effort delete; S3 DeleteObject is idempotent.
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key }));

    // Clear any cached job state so GET will re-check S3.
    const k = jobKey(video, style, t);
    jobs.delete(k);

    return res.status(200).json({ status: "deleted", key: Key });
  } catch (e) {
    console.log("DELETE /comics error:", e);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// Generate an image by calling the OpenAI Images edits endpoint with the captured video frame.
// Uploads result to S3 at the provided Key and returns the public URL.
async function generateImageFromFrame(frameBytes, contentType, prompt, Key) {
  try {
    // Use the GPT image endpoint for generation.
    const apiUrl = "https://api.openai.com/v1/images/edits";

    const ct = String(contentType || "image/jpeg");
    const form = new FormData();

    form.append("model", "gpt-image-1");
    form.append("prompt", prompt);
    form.append("size", "1024x1024");

    // GPT image models always return base64; use output_format to control encoding.
    form.append("output_format", "jpeg");
    form.append("output_compression", "85");

    // API accepts one or more images; use image[]
    form.append(
      "image[]",
      new Blob([frameBytes], { type: ct.includes("png") ? "image/png" : "image/jpeg" }),
      "frame" + (ct.includes("png") ? ".png" : ".jpg")
    );

    const r = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: form
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.log("OpenAI images/edits error:", r.status, txt);
      return null;
    }

    const json = await r.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) {
      console.log("OpenAI images/edits: missing b64_json, response was:", JSON.stringify(json));
      return null;
    }

    const outBytes = Buffer.from(b64, "base64");
    await uploadToS3(outBytes, Key, "image/jpeg");
    return comicsUrlForKey(Key);
  } catch (e) {
    console.log("generateImageFromFrame error:", e);
    return null;
  }
}

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  }
});

async function uploadToS3(Body, Key, ContentType) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key,
    Body,
    ContentType,
    CacheControl: "no-cache, no-store, must-revalidate, max-age=0"
  }));
  return comicsUrlForKey(Key);
}
