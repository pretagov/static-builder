// SSG builder webhook receiver.
//
// Each site runs it on a Fly app of its own that auto-suspends to zero when
// idle. The site's Plone fires a webhook on content publish, Fly wakes the
// machine, and this server runs the site's run-build.sh: the site's own build,
// then publish.mjs to put it on Bunny.
//
// Coalescing: at most one build runs at a time. If a webhook arrives
// while a build is in-flight we just set a "pending" flag; when the
// current build finishes, if pending is set, we kick off one more
// (and clear the flag). 10 saves in 30 seconds → 2 builds, not 10.
//
// Auth: path-token. The Plone content rule POSTs to
// /build/<BUILDER_WEBHOOK_SECRET>. The collective.webhook addon doesn't
// support custom headers (only url/method/payload), so we can't do
// header-based HMAC. The threat model is "trigger an extra build",
// nothing more — a leaked path-token just means we burn some build
// minutes, not data loss. TLS protects the token in transit.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const SECRET = process.env.BUILDER_WEBHOOK_SECRET;
const BUILD_SCRIPT = resolve(process.env.BUILD_SCRIPT ?? './run-build.sh');
// Public URL the keepalive pings while a build is in flight. Fly's
// autosuspend timer counts incoming proxy traffic, not internal process
// activity — without this, the machine suspends after ~5 min of "no
// HTTP" and kills the running build mid-prerender.
const PUBLIC_URL = process.env.BUILDER_PUBLIC_URL;
// Hard ceiling on a single build. The keepalive below deliberately keeps the
// machine awake while a build runs, so a hung/pathologically-slow build would
// otherwise run forever (a cold sourcemap build once took ~53min). When this
// fires we kill the whole build process tree and stop the keepalive so Fly can
// suspend the machine. Override via MAX_BUILD_MS.
//
// 30min, not 15: a real build legitimately runs ~18-20min on this 2-shared-CPU
// VM — the `build-ssg.sh` warm step alone waits up to ~10min for the cold,
// auto-suspended site API to warm before prerendering, then prod +
// edit compiles + Bunny sync. 15min killed healthy builds mid-edit-build.
const MAX_BUILD_MS = parseInt(process.env.MAX_BUILD_MS ?? String(30 * 60_000), 10);

if (!SECRET) {
  console.error('BUILDER_WEBHOOK_SECRET must be set');
  process.exit(1);
}
// No default: every site's builder is its own machine, and a default would
// point the keepalive at one site's.
if (!PUBLIC_URL) {
  console.error('BUILDER_PUBLIC_URL must be set (this builder\'s own https://<app>.fly.dev)');
  process.exit(1);
}

// Build state. Only ever mutated from the main thread.
let inflight = null;       // child_process.ChildProcess | null
let pending = false;       // another build was requested while inflight
// Consecutive watchdog kills. One retry is worth it (a cold dependency is
// warm by the second attempt); past that we are burning windows, not building.
let timedOutRetries = 0;
const MAX_TIMEOUT_RETRIES = 1;
let lastResult = null;     // { exitCode, startedAt, finishedAt, tail? } | null

// The last lines the build printed, kept so a FAILURE can say why.
//
// The build's output reaches Fly's logs and nothing else, so a deploy waiting
// on the builder failed with `exitCode=1` and no diagnosis: at one point 6 of
// 12 deploys of one site, each unexplainable without shelling into the builder
// while the logs were still in retention. Bounded on purpose: a full build log
// is megabytes, and this is held in memory and served over HTTP.
const TAIL_LINES = 200;
const TAIL_LINE_MAX = 500;
let tailBuffer = [];

function recordOutput(chunk) {
  for (const line of chunk.toString().split('\n')) {
    if (!line) continue;
    tailBuffer.push(line.length > TAIL_LINE_MAX ? `${line.slice(0, TAIL_LINE_MAX)}…` : line);
  }
  if (tailBuffer.length > TAIL_LINES) tailBuffer = tailBuffer.slice(-TAIL_LINES);
}

function verifyToken(providedToken) {
  if (typeof providedToken !== 'string' || providedToken.length === 0) return false;
  const a = Buffer.from(SECRET);
  const b = Buffer.from(providedToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Keepalive: hold ONE inbound connection open for the whole build.
//
// This used to ping /healthz every 60s, and the machine was autosuspended
// mid-build anyway — twice on 2026-10-15, 13 minutes into one build and 65
// seconds into the next, with the pings supposedly running. www then served a
// half-finished render for hours.
//
// Fly reports "has excess capacity, autosuspending": that is the proxy's view
// of CONCURRENCY, not an idle clock. A request that completes drops concurrency
// straight back to zero, so 60s pings leave 59s of looking idle. A request that
// STAYS OPEN holds it at >= 1 for as long as it is open, which is the thing the
// proxy actually counts.
//
// The old version also swallowed every error (`.catch(() => {})`), so a
// keepalive that never reached the proxy at all looked exactly like one that
// worked — which is most of why this took an outage to find. Failures are
// logged now, and builder/server.test.mjs asserts the invariant directly.
const HOLD_HEARTBEAT_MS = 15_000;
const HOLD_RETRY_MS = 2_000;

let keepaliveActive = false;
const holdResponses = new Set();

function startKeepalive() {
  if (keepaliveActive) return;
  keepaliveActive = true;
  openHold();
}

// Opens a hold and re-opens it if it drops, until the build is done. Fly's
// proxy may still cut a long-lived connection; losing one must not quietly
// leave the rest of the build unprotected.
async function openHold() {
  while (keepaliveActive) {
    try {
      const res = await fetch(`${PUBLIC_URL}/hold`);
      if (!res.ok || !res.body) throw new Error(`hold responded ${res.status}`);
      console.log('[keepalive] hold open');
      for await (const _beat of res.body) { /* drain until the server ends it */ }
      console.log('[keepalive] hold closed');
    } catch (err) {
      console.error(`[keepalive] hold failed: ${err.message}`);
    }
    if (!keepaliveActive) break;
    await new Promise((r) => setTimeout(r, HOLD_RETRY_MS));
  }
}

function stopKeepalive() {
  keepaliveActive = false;
  for (const res of holdResponses) {
    try { res.end(); } catch { /* already gone */ }
  }
  holdResponses.clear();
}

function runBuild() {
  const startedAt = new Date().toISOString();
  console.log(`[build] starting at ${startedAt}`);
  // detached: own process group, so the watchdog can kill the WHOLE tree
  // (bash → pnpm → nuxt → vite). Killing just the bash pid orphans the
  // heavy children, which is how concurrent zombie builds piled up before.
  tailBuffer = [];
  const child = spawn('bash', [BUILD_SCRIPT], {
    // `pipe`, not `inherit`: echoed through below, so Fly's logs are unchanged,
    // and also kept so a failure can report its own reason.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: true,
  });
  child.stdout.on('data', (chunk) => { process.stdout.write(chunk); recordOutput(chunk); });
  child.stderr.on('data', (chunk) => { process.stderr.write(chunk); recordOutput(chunk); });
  inflight = child;
  startKeepalive();

  let timedOut = false;
  const killTree = (signal) => {
    try { process.kill(-child.pid, signal); }   // negative pid = process group
    catch { try { child.kill(signal); } catch { /* already gone */ } }
  };
  const watchdog = setTimeout(() => {
    timedOut = true;
    console.error(`[build] exceeded MAX_BUILD_MS=${MAX_BUILD_MS}ms — terminating build`);
    killTree('SIGTERM');
    // escalate if it ignores SIGTERM
    setTimeout(() => { if (inflight === child) killTree('SIGKILL'); }, 15_000);
  }, MAX_BUILD_MS);

  child.on('exit', (exitCode, signal) => {
    clearTimeout(watchdog);
    const finishedAt = new Date().toISOString();
    console.log(`[build] finished exit=${exitCode} signal=${signal} timedOut=${timedOut} at ${finishedAt}`);
    inflight = null;
    const failed = exitCode !== 0 || timedOut;
    lastResult = {
      exitCode, signal, timedOut, startedAt, finishedAt,
      // Only on failure: /healthz is polled while a deploy waits, and a
      // successful build has nothing to explain.
      ...(failed ? { tail: tailBuffer.slice(-120) } : {}),
    };
    // At least one build must run AFTER the last change.
    //
    // `pending` is a flag, not a queue: the webhook body is discarded and every
    // build renders whatever live content says at that moment, so ten saves
    // during a build need exactly one build afterwards and it picks up all ten.
    //
    // This used to clear that flag without running it whenever the build had
    // timed out, so as not to burn another window immediately. The cost was
    // silence: the save was acknowledged, no build covered it, and nothing said
    // so — www kept serving the previous render until someone happened to edit
    // again. A cold API makes a timeout realistic (a manual build once took
    // 15m31s against a 5m50s baseline).
    //
    // So retry once — a timeout is usually a cold dependency that is warm by
    // the second attempt. Retrying harder would not help if builds keep timing
    // out; the answer to that is to make the build finish (warm the API first,
    // or raise MAX_BUILD_MS), so past one retry we stop and say so.
    timedOutRetries = timedOut ? timedOutRetries + 1 : 0;
    if (pending && (!timedOut || timedOutRetries <= MAX_TIMEOUT_RETRIES)) {
      pending = false;
      runBuild();
    } else {
      if (pending) {
        // Visible in the log AND on /healthz: a request we accepted and did
        // not honour is the one thing this server must never hide.
        console.error(
          `[build] dropped a queued build after ${timedOutRetries} timed-out ` +
            `attempt(s) — the site is NOT up to date with the last save`,
        );
        lastResult = { ...lastResult, droppedPending: true };
      }
      pending = false;
      stopKeepalive();
    }
  });
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

const server = createServer(async (req, res) => {
  // Trim query string for routing (collective.webhook always appends ${url}-
  // style interpolation we don't care about reading at the URL level).
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // `holds` is the keepalive invariant made observable: >0 while building is
    // the whole reason the machine stays up. Without it on healthz there is no
    // way to tell a live keepalive from a dead one.
    res.end(JSON.stringify({
      ok: true, inflight: !!inflight, pending, holds: holdResponses.size, lastResult,
    }));
    return;
  }
  // The keepalive's own long-lived connection (see startKeepalive).
  if (req.method === 'GET' && path === '/hold') {
    if (!inflight) {
      // An unsolicited hold must not be able to pin the machine awake — and
      // billable — with no build to protect.
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'no build in flight' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    holdResponses.add(res);
    // A silent stream can still be reaped by an intermediary; a byte every 15s
    // keeps it demonstrably alive without being traffic worth the name.
    const beat = setInterval(() => { try { res.write('.'); } catch { /* closing */ } }, HOLD_HEARTBEAT_MS);
    // Belt and braces: if a build is ever lost without stopKeepalive running,
    // the hold still expires rather than keeping the machine up forever.
    const ceiling = setTimeout(() => { try { res.end(); } catch { /* gone */ } }, MAX_BUILD_MS + 60_000);
    const cleanup = () => { clearInterval(beat); clearTimeout(ceiling); holdResponses.delete(res); };
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.write('.');
    return;
  }
  // /build/<token> — token is the BUILDER_WEBHOOK_SECRET.
  const buildMatch = /^\/build\/([^/]+)$/.exec(path);
  if (req.method !== 'POST' || !buildMatch) {
    res.writeHead(404).end();
    return;
  }
  // Drain the body even though we don't use it — leaving an unread body
  // open can confuse the upstream.
  await readBody(req);
  if (!verifyToken(buildMatch[1])) {
    console.warn('[build] rejected: bad token');
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'bad token' }));
    return;
  }
  if (inflight) {
    pending = true;
    console.log('[build] coalesced (in-flight already)');
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, coalesced: true }));
    return;
  }
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, coalesced: false }));
  runBuild();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[builder] listening on :${PORT}`);
});
