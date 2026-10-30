#!/usr/bin/env node
// Sync a local directory to a Bunny.net Storage Zone.
//
// - HTTP keep-alive + bounded parallelism (controls per-file overhead).
// - Diff-based: skips files whose remote size matches local. A typical
//   content-only edit re-uploads a handful of HTML files, not 3,500.
// - Stale-file delete: anything in storage but not in the build is
//   removed, so deleted pages don't keep responding 200 forever.
// - Asset-before-HTML ordering: uploads are sorted so hashed assets (/_nuxt/,
//   /_next/static/: BUNNY_IMMUTABLE_PREFIXES) go up first, so <hash>.js
//   lands before the /index.html that references it. Mid-sync, old HTML
//   keeps pointing at old (still-present) hashed assets — the dangerous
//   case (new HTML pointing at a not-yet-uploaded asset) is avoided.
//
// Usage:
//   BUNNY_STORAGE_ZONE=... BUNNY_STORAGE_ENDPOINT=... \
//   BUNNY_STORAGE_PASSWORD=... BUNNY_IMMUTABLE_PREFIXES=_nuxt/,edit/_nuxt/ \
//   node bunny-sync.mjs <local-dir>
//
// BUNNY_IMMUTABLE_PREFIXES names the framework's content-hashed asset folders
// (comma-separated): `_nuxt/` for Nuxt, `_next/static/` for Next.js. They go up
// first and are never deleted (see the stale-file delete below).
//
// Exits nonzero if any upload or delete fails.

import { readFile, stat, readdir } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { argv, exit, env } from 'node:process';

const localDir = argv[2];
if (!localDir) {
  console.error('usage: bunny-sync.mjs <local-dir>');
  exit(2);
}
const ZONE = env.BUNNY_STORAGE_ZONE;
const HOST = env.BUNNY_STORAGE_ENDPOINT;
const KEY = env.BUNNY_STORAGE_PASSWORD;
const PARALLEL = parseInt(env.BUNNY_SYNC_PARALLEL ?? '16', 10);
if (!ZONE || !HOST || !KEY || !env.BUNNY_IMMUTABLE_PREFIXES) {
  console.error('BUNNY_STORAGE_ZONE, BUNNY_STORAGE_ENDPOINT, BUNNY_STORAGE_PASSWORD, BUNNY_IMMUTABLE_PREFIXES must be set');
  exit(2);
}
const IMMUTABLE_PREFIXES = env.BUNNY_IMMUTABLE_PREFIXES.split(',').map((p) => p.trim()).filter(Boolean);
const isImmutableAsset = (rel) => IMMUTABLE_PREFIXES.some((prefix) => rel.startsWith(prefix));
// A bare host (uk.storage.bunnycdn.com) is Bunny over https; a URL with its
// own scheme is used as given, which is how the tests reach a fake zone.
const BASE = HOST.includes('://') ? `${HOST}/${ZONE}` : `https://${HOST}/${ZONE}`;

// Bunny serves files with a Content-Type inferred from the extension, so this
// is belt-and-suspenders for the common case — but it makes the served type
// explicit and correct for entries Bunny's table is iffy on (.mjs, .webmanifest,
// .avif, .wasm) and for any extensionless file. Unknown extensions fall through
// to no header (Bunny's inference), which is the prior behaviour.
const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
};
function contentTypeFor(rel) {
  // ipxStatic writes extensionless files (e.g. _ipx/w_1600&f_webp/.../@@images/image)
  // whose OUTPUT format lives in the modifier segment, not the filename — Bunny
  // would otherwise serve them as application/octet-stream. Derive the type from
  // the f_webp/f_avif modifier, falling back to the source filename's extension.
  if (rel.startsWith('_ipx/')) {
    if (rel.includes('f_webp')) return MIME.webp;
    if (rel.includes('f_avif')) return MIME.avif;
    const m = rel.match(/\.(jpe?g|png|gif|svg|webp|avif|ico)(?=[/&]|$)/i);
    if (m) return MIME[m[1].toLowerCase()] ?? null;
    return null;
  }
  const i = rel.lastIndexOf('.');
  if (i < 0) return null;
  return MIME[rel.slice(i + 1).toLowerCase()] ?? null;
}

// The essential media type, for tolerant comparison: lowercased, no parameters
// (`; charset=utf-8`), no surrounding space. Bunny's stored ContentType may omit
// or normalise the charset we PUT, so comparing full strings would flag every
// text asset as "wrong" and re-upload it every run.
function essenceOf(ct) {
  return (ct || '').split(';')[0].trim().toLowerCase();
}

// True when the remote object's stored type disagrees with what we'd set. Only
// meaningful when we HAVE an expected type — a null `want` (files we leave to
// Bunny's own inference) never counts as a mismatch, so those are never churned.
function contentTypeMismatch(remoteType, want) {
  if (!want) return false;
  return essenceOf(remoteType) !== essenceOf(want);
}

// ---------- file/listing helpers ----------

async function walkLocal(root) {
  const out = new Map(); // posix-relative path → { absPath, size }
  async function recurse(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (e) => {
      const abs = join(dir, e.name);
      if (e.isDirectory()) return recurse(abs);
      if (!e.isFile()) return;
      const s = await stat(abs);
      // Skip sourcemaps — useless on the CDN, ~5-10% of total volume.
      if (abs.endsWith('.map')) return;
      const rel = posix.normalize(relative(root, abs).split(/[\\/]/).join('/'));
      out.set(rel, { absPath: abs, size: s.size });
    }));
  }
  await recurse(root);
  return out;
}

// Bunny's edge occasionally drops a socket mid-sync ("fetch failed / other side
// closed") or returns a transient 5xx/429. Without a retry a single blip kills
// the whole build (the LIST throws straight to the top-level [sync] fatal catch;
// PUT/DELETE errors are collected but still fail the sync). Retry transient
// failures with exponential backoff. 4xx (real errors) surface immediately.
async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        const wait = 500 * 2 ** i; // 0.5s, 1s, 2s
        console.warn(`[sync] ${opts.method || 'GET'} ${url} failed (${e.message}); retry ${i + 1}/${tries - 1} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function listBunny(path = '/') {
  const url = `${BASE}${path}`;
  const res = await fetchRetry(url, { headers: { AccessKey: KEY, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`LIST ${url} → ${res.status}`);
  return res.json();
}

async function walkBunny() {
  const out = new Map(); // posix-relative path → { size, contentType }
  async function recurse(prefix) {
    const items = await listBunny(prefix);
    const subdirs = [];
    for (const it of items) {
      if (it.IsDirectory) {
        subdirs.push(prefix + it.ObjectName + '/');
      } else {
        // ContentType is what the storage zone will serve the object AS. We diff
        // against it so an object whose bytes are unchanged but whose stored type
        // is wrong (e.g. an extensionless _ipx SVG stored as octet-stream) still
        // gets re-PUT with the right header — the size-only diff was blind to it.
        out.set(prefix.slice(1) + it.ObjectName, {
          size: it.Length,
          contentType: it.ContentType || '',
        });
      }
    }
    // List subdirs in parallel, bounded by overall transfer concurrency
    // upstream — small enough to be fine here.
    await Promise.all(subdirs.map(recurse));
  }
  await recurse('/');
  return out;
}

// ---------- transfer helpers ----------

// Sort key for atomicity: hashed assets first, then everything else (Next's
// per-route RSC payloads included: a client navigation fetches them, so they
// must not lag the HTML that links there), then index.html files last. Within
// a tier, alphabetical.
function uploadSortKey(rel) {
  if (isImmutableAsset(rel)) return `0|${rel}`;
  if (rel.endsWith('.html')) return `2|${rel}`;
  return `1|${rel}`;
}

function encodePathForUrl(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

// Enough of a magic-byte table for what Plone serves. Only consulted when the
// filename cannot answer — a wrong guess here would be worse than none, so
// anything unrecognised returns null and Bunny falls back to its own inference.
function sniffMagic(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return MIME.png;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return MIME.jpg;
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF89a') return MIME.gif;
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF87a') return MIME.gif;
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return MIME.webp;
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp' && buf.subarray(8, 12).toString('ascii').startsWith('avif')) return MIME.avif;
  const head = buf.subarray(0, 256).toString('utf8').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return MIME.svg;
  return null;
}

async function putOne(rel, absPath) {
  const url = `${BASE}/${encodePathForUrl(rel)}`;
  const body = await readFile(absPath);
  // A file whose name gives no type (an extensionless image scale, say) is
  // typed from its bytes rather than served as a download.
  const ct = contentTypeFor(rel) ?? sniffMagic(body);
  const res = await fetchRetry(url, {
    method: 'PUT',
    headers: ct ? { AccessKey: KEY, 'Content-Type': ct } : { AccessKey: KEY },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT ${rel} → ${res.status} ${text.slice(0, 120)}`);
  }
}

async function deleteOne(rel) {
  const url = `${BASE}/${encodePathForUrl(rel)}`;
  const res = await fetchRetry(url, {
    method: 'DELETE',
    headers: { AccessKey: KEY },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE ${rel} → ${res.status}`);
  }
}

// Run async tasks with bounded concurrency. Collects errors but does
// NOT short-circuit — a single transient failure won't abandon work
// already in flight, and we get the full list at the end.
async function runBounded(items, fn, label) {
  let i = 0;
  const errors = [];
  let done = 0;
  const total = items.length;
  let lastLog = Date.now();
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= total) return;
      try {
        await fn(items[idx]);
      } catch (e) {
        errors.push({ item: items[idx], err: e });
        console.error(`[${label}] ${e.message}`);
      } finally {
        done++;
        if (Date.now() - lastLog > 5000) {
          console.log(`[${label}] ${done}/${total}`);
          lastLog = Date.now();
        }
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  console.log(`[${label}] done: ${done - errors.length} ok, ${errors.length} failed`);
  return errors;
}

// ---------- main ----------

async function main() {
  const t0 = Date.now();
  console.log(`[sync] local=${localDir} remote=${BASE} parallel=${PARALLEL}`);

  const [local, remote] = await Promise.all([walkLocal(localDir), walkBunny()]);
  console.log(`[sync] local files: ${local.size}, remote files: ${remote.size}`);

  // Build upload + delete sets.
  // BUNNY_SYNC_FORCE=1 re-uploads EVERY local file, bypassing the size-diff
  // skip. Recovery path for Bunny storage LIST/GET inconsistency: the LIST API
  // can report a file present (so the diff skips it) while a GET 404s from a
  // storage replica — re-PUTting to the primary overwrites + re-replicates.
  const FORCE = !!env.BUNNY_SYNC_FORCE;
  const toUpload = [];
  for (const [rel, lf] of local) {
    const rf = remote.get(rel);
    // ALWAYS re-upload HTML. A size-only diff is blind to same-byte-size content
    // changes — most importantly an equal-length asset-hash swap in every page
    // (e.g. entry.CNCrdOlG.css -> entry.DGZrqTsB.css), which leaves the HTML
    // exactly the same size but pointing at a different stylesheet. That bug
    // left all ~373 pages stale on Bunny while only the new CSS uploaded. HTML
    // is small and few, so unconditionally syncing it is cheap and correct.
    //
    // Content-type drift: an object whose bytes match but whose STORED type is
    // wrong (the classic case is an extensionless `_ipx/…/@@images/image` SVG
    // that landed as application/octet-stream before contentTypeFor knew to type
    // it) is invisible to the size diff, so it never self-corrects. Re-PUT it
    // when we have an expected type and the remote's differs — putOne sends the
    // right Content-Type. Only compared when contentTypeFor(rel) is non-null, so
    // files we don't type (Bunny's own inference) are never churned.
    const typeWrong = rf && contentTypeMismatch(rf.contentType, contentTypeFor(rel));
    if (FORCE || !rf || rf.size !== lf.size || rel.endsWith('.html') || typeWrong) {
      toUpload.push({ rel, absPath: lf.absPath });
    }
  }
  if (FORCE) console.log('[sync] BUNNY_SYNC_FORCE set — re-uploading all files');
  toUpload.sort((a, b) => uploadSortKey(a.rel).localeCompare(uploadSortKey(b.rel)));

  // Stale-file delete — but NEVER delete hashed, immutable build assets.
  // A new build gives changed chunks new hashes (e.g. B0klcdcl.js); the old
  // hashes become "not in local". Deleting them breaks any page whose HTML is
  // still edge-cached (up to the HTML TTL, ~3h here) and references the old
  // hash -> 404 -> the whole page loses its JS and stops hydrating. Hashed
  // assets are content-addressed and tiny, so we KEEP them (a separate,
  // time-based prune can remove ones older than the HTML TTL). Only non-asset
  // files (stale HTML, images, etc.) are deleted.
  const toDelete = [];
  for (const rel of remote.keys()) {
    if (local.has(rel)) continue;
    if (isImmutableAsset(rel)) continue; // keep old hashed assets
    toDelete.push(rel);
  }

  console.log(`[sync] upload: ${toUpload.length}, delete: ${toDelete.length}, unchanged: ${local.size - toUpload.length}`);

  const uploadErrors = toUpload.length
    ? await runBounded(toUpload, ({ rel, absPath }) => putOne(rel, absPath), 'upload')
    : [];
  const deleteErrors = toDelete.length
    ? await runBounded(toDelete, (rel) => deleteOne(rel), 'delete')
    : [];

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] complete in ${dt}s (uploads ${toUpload.length - uploadErrors.length}/${toUpload.length}, deletes ${toDelete.length - deleteErrors.length}/${toDelete.length})`);

  if (uploadErrors.length || deleteErrors.length) {
    console.error(`[sync] FAILED: ${uploadErrors.length + deleteErrors.length} errors`);
    exit(1);
  }
}

main().catch((e) => {
  console.error('[sync] fatal:', e);
  exit(1);
});
