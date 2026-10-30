/**
 * The builder's keepalive must hold a real connection open for the whole build.
 *
 * Why this test exists: on 2026-10-15 the builder machine was autosuspended
 * TWICE mid-build — 13 minutes into one, 65 seconds into the next — while the
 * keepalive was, as far as anyone could tell, running. www then served a
 * half-finished render for hours. The keepalive pinged every 60s and swallowed
 * every error, so there was no way to tell a working keepalive from one that
 * never reached the proxy at all.
 *
 * Fly's autosuspend reports "excess capacity": it is the proxy's view of
 * CONCURRENCY, not an idle clock. An instantaneous request drops concurrency
 * back to zero the moment it completes, so 60s pings leave 59s of looking idle.
 * The invariant that actually keeps the machine up is the one asserted here:
 * while a build is in flight, at least one inbound connection stays OPEN.
 *
 * Run: node --test
 */
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER = resolve(import.meta.dirname, 'server.mjs');
const SECRET = 'test-secret-token';

/** Ask the OS for a port nothing is using, then hand it over. */
function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.on('error', rej);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

/** Poll `fn` until it returns truthy, or throw after `timeoutMs`. */
async function until(fn, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await fn();
            if (last) return last;
        } catch (err) {
            last = err.message;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function health(port) {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    return r.json();
}

/**
 * Boot the real server against a build script that just sleeps, with the
 * keepalive pointed back at the server itself (no Fly, no network).
 */
async function startServer(buildSeconds, maxBuildMs = 60_000, body = `sleep ${buildSeconds}`) {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'builder-test-'));
    const script = join(dir, 'fake-build.sh');
    writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`);

    const child = spawn('node', [SERVER], {
        env: {
            ...process.env,
            PORT: String(port),
            BUILDER_WEBHOOK_SECRET: SECRET,
            BUILD_SCRIPT: script,
            BUILDER_PUBLIC_URL: `http://127.0.0.1:${port}`,
            MAX_BUILD_MS: String(maxBuildMs),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = [];
    child.stdout.on('data', (d) => log.push(d.toString()));
    child.stderr.on('data', (d) => log.push(d.toString()));

    await until(() => health(port).then((h) => h.ok), 5000, 'server to listen');
    return { port, child, log };
}

test('a connection stays open for as long as the build runs', async (t) => {
    const { port, child, log } = await startServer(5);
    t.after(() => child.kill('SIGKILL'));

    const kick = await fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' });
    assert.equal(kick.status, 202, 'webhook should be accepted');

    await until(() => health(port).then((h) => h.inflight), 3000, 'build to start');

    // THE INVARIANT. Not "a request happened recently" — a request that is
    // still open right now, which is the only thing Fly's proxy counts.
    const h = await until(
        () => health(port).then((x) => (x.holds > 0 ? x : null)),
        5000,
        `an open hold while building (log: ${log.join('')})`,
    );
    assert.ok(h.holds >= 1, `expected >=1 open hold, got ${h.holds}`);
    assert.equal(h.inflight, true, 'build should still be in flight');

    // Still open well after a single 60s ping window would have lapsed into
    // idle — sampled repeatedly so a hold that drops and never returns fails.
    for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const s = await health(port);
        if (!s.inflight) break;
        assert.ok(s.holds >= 1, `hold dropped mid-build at sample ${i} (holds=${s.holds})`);
    }
});

test('the connection is released once the build finishes', async (t) => {
    const { port, child } = await startServer(1);
    t.after(() => child.kill('SIGKILL'));

    await fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' });
    await until(() => health(port).then((h) => h.inflight), 3000, 'build to start');
    await until(() => health(port).then((h) => !h.inflight), 10_000, 'build to finish');

    // A hold that outlives its build would pin the machine awake — and billable
    // — forever. This is the other half of the invariant.
    const h = await until(
        () => health(port).then((x) => (x.holds === 0 ? x : null)),
        5000,
        'holds to drain after the build',
    );
    assert.equal(h.holds, 0);
    assert.equal(h.lastResult?.exitCode, 0, 'fake build should have succeeded');
});

test('a hold is refused when no build is running', async (t) => {
    const { port, child } = await startServer(1);
    t.after(() => child.kill('SIGKILL'));

    // Nothing in flight: an unsolicited hold must not be able to keep the
    // machine awake on its own.
    const r = await fetch(`http://127.0.0.1:${port}/hold`);
    assert.equal(r.status, 409);
    await r.text();
    assert.equal((await health(port)).holds, 0);
});


/**
 * A build killed by the watchdog must not swallow the work queued behind it.
 *
 * Coalescing is the point of `pending`: a webhook arriving mid-build sets it,
 * and the build that finishes runs one more pass to pick up whatever was saved
 * in the meantime. But the exit handler cleared `pending` WITHOUT running it
 * when the build had timed out — deliberately, so a build that blew its budget
 * could not immediately burn another window.
 *
 * The cost was silence. The editor's save was acknowledged, no build covered
 * it, and nothing said so: www kept serving the previous render until somebody
 * happened to edit again. Today's manual build took 15m31s against a 5m50s
 * baseline because the API was cold, so blowing the budget is not theoretical.
 *
 * Retry once — a timeout is usually a cold dependency that is now warm — and
 * if that retry times out too, stop and SAY so rather than dropping it.
 */
test('a queued build still runs after the one before it times out', async (t) => {
    // Build takes 3s, watchdog fires at 1s: the first build always times out.
    const { port, child, log } = await startServer(3, 1_000);
    t.after(() => child.kill('SIGKILL'));

    await fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' });
    await until(() => health(port).then((h) => h.inflight), 3000, 'first build to start');

    // A save lands while it is running.
    const queued = await fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' });
    assert.equal(queued.status, 202);
    assert.equal((await queued.json()).coalesced, true, 'second kick should coalesce');

    // The first build is killed by the watchdog. The queued one must still run.
    const started = log.join('');
    await until(
        () => (log.join('').match(/\[build\] starting/g) || []).length >= 2 ? true : null,
        15_000,
        `a second build after the timeout (log so far: ${started})`,
    );
});

test('a dropped build is reported, not silently forgotten', async (t) => {
    const { port, child, log } = await startServer(3, 1_000);
    t.after(() => child.kill('SIGKILL'));

    // Keep a save queued behind EVERY attempt — including the retry — so the
    // server runs out of retries with work still outstanding.
    await fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' });
    const keepQueuing = setInterval(() => {
      fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' }).catch(() => {});
    }, 200);
    t.after(() => clearInterval(keepQueuing));

    const h = await until(
        () => health(port).then((x) => (x.lastResult?.droppedPending ? x : null)),
        20_000,
        `healthz to admit a dropped build (log: ${log.join('')})`,
    );
    assert.equal(h.lastResult.droppedPending, true);
    assert.match(log.join(''), /dropped/i, 'and to say so in the log');
});

/**
 * A failed build says why, on /healthz.
 *
 * The build's output used to reach Fly's logs only. A deploy that waited on
 * the builder failed with `exitCode=1` and nothing else, and the reason was
 * gone once the logs aged out. The last lines are kept and reported with the
 * failure. Only with a failure: a successful build has nothing to explain, and
 * /healthz is polled while a deploy waits.
 */
test('a failed build reports its last output lines', async (t) => {
    const { port, child } = await startServer(0, 60_000, 'echo "step one"\necho "rendering /about failed: 500" >&2\nexit 1');
    t.after(() => child.kill('SIGKILL'));

    await fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' });
    const h = await until(
        () => health(port).then((x) => (x.lastResult ? x : null)),
        10_000,
        'the build to finish',
    );
    assert.equal(h.lastResult.exitCode, 1);
    assert.deepEqual(h.lastResult.tail, ['step one', 'rendering /about failed: 500']);
});

test('a successful build reports no output', async (t) => {
    const { port, child } = await startServer(0, 60_000, 'echo "all good"');
    t.after(() => child.kill('SIGKILL'));

    await fetch(`http://127.0.0.1:${port}/build/${SECRET}`, { method: 'POST' });
    const h = await until(
        () => health(port).then((x) => (x.lastResult ? x : null)),
        10_000,
        'the build to finish',
    );
    assert.equal(h.lastResult.exitCode, 0);
    assert.equal('tail' in h.lastResult, false);
});

test('the server will not start without its public URL', async () => {
    // The keepalive reaches the machine through its public URL. A default would
    // point every site's builder at one site's machine.
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), BUILDER_WEBHOOK_SECRET: SECRET };
    delete env.BUILDER_PUBLIC_URL;
    const child = spawn('node', [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (d) => stderr.push(d.toString()));
    // Bounded: a server that ignores the missing URL listens forever.
    const code = await Promise.race([
        new Promise((r) => child.on('exit', r)),
        new Promise((r) => setTimeout(() => { child.kill('SIGKILL'); r('still running after 5s'); }, 5000)),
    ]);
    assert.equal(code, 1);
    assert.match(stderr.join(''), /BUILDER_PUBLIC_URL must be set/);
});
