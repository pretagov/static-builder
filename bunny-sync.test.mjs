// Run with: node --test
//
// bunny-sync.mjs against a fake Bunny Storage zone: the listing, PUT and DELETE
// it would send to the real one, recorded in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import os from 'node:os';

const SYNC = resolve(import.meta.dirname, 'bunny-sync.mjs');
const ZONE = 'testzone';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A storage zone holding `objects` ({ path: { size, contentType } }). */
async function fakeZone(objects) {
  const calls = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(`/${ZONE}/`, '');
    if (req.method === 'GET') {
      // A directory listing: the immediate children of `path`.
      const children = new Map();
      for (const [key, meta] of Object.entries(objects)) {
        if (!key.startsWith(path)) continue;
        const rest = key.slice(path.length);
        const [head, ...tail] = rest.split('/');
        if (tail.length) children.set(head, { ObjectName: head, IsDirectory: true });
        else children.set(head, { ObjectName: head, IsDirectory: false, Length: meta.size, ContentType: meta.contentType });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...children.values()]));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ method: req.method, path, contentType: req.headers['content-type'] ?? null });
      if (req.method === 'PUT') objects[path] = { size: Buffer.concat(chunks).length, contentType: req.headers['content-type'] ?? '' };
      if (req.method === 'DELETE') delete objects[path];
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, objects, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function build(files) {
  const dir = mkdtempSync(join(os.tmpdir(), 'sync-build-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function sync(dir, endpoint, prefixes) {
  return new Promise((resolveRun) => {
    const child = spawn('node', [SYNC, dir], {
      env: {
        ...process.env,
        BUNNY_STORAGE_ZONE: ZONE,
        BUNNY_STORAGE_ENDPOINT: endpoint,
        BUNNY_STORAGE_PASSWORD: 'key',
        BUNNY_IMMUTABLE_PREFIXES: prefixes,
        // One at a time, so the order the zone sees is the order the sync chose.
        BUNNY_SYNC_PARALLEL: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d.toString()));
    child.stderr.on('data', (d) => out.push(d.toString()));
    child.on('exit', (code) => resolveRun({ code, log: out.join('') }));
  });
}

test('a Next.js build: assets first, old hashed assets kept, stale pages removed', async (t) => {
  const zone = await fakeZone({
    '_next/static/old-abc.js': { size: 3, contentType: 'text/javascript; charset=utf-8' },
    'removed-page/index.html': { size: 3, contentType: 'text/html; charset=utf-8' },
  });
  t.after(zone.close);
  const dir = build({
    'about/index.html': '<html>about</html>',
    '_next/static/new-def.js': 'console.log(1)',
  });

  const { code, log } = await sync(dir, zone.endpoint, '_next/static/');
  assert.equal(code, 0, log);

  const puts = zone.calls.filter((c) => c.method === 'PUT').map((c) => c.path);
  assert.deepEqual(puts, ['_next/static/new-def.js', 'about/index.html'], 'the asset goes up before the page that loads it');
  assert.ok('_next/static/old-abc.js' in zone.objects, 'an old hashed asset stays for edge-cached pages that still load it');
  assert.equal('removed-page/index.html' in zone.objects, false, 'a page the build no longer has is removed');
});

test('a file with no extension is typed from its bytes', async (t) => {
  const zone = await fakeZone({});
  t.after(zone.close);
  const dir = build({ 'images/photo/@@images/image': PNG });

  const { code, log } = await sync(dir, zone.endpoint, '_nuxt/');
  assert.equal(code, 0, log);
  const put = zone.calls.find((c) => c.method === 'PUT');
  assert.equal(put.contentType, 'image/png');
});

test('the hashed-asset folders must be named', async () => {
  const dir = build({ 'index.html': 'x' });
  const child = spawn('node', [SYNC, dir], {
    env: { ...process.env, BUNNY_STORAGE_ZONE: ZONE, BUNNY_STORAGE_ENDPOINT: 'http://127.0.0.1:9', BUNNY_STORAGE_PASSWORD: 'key', BUNNY_IMMUTABLE_PREFIXES: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const err = [];
  child.stderr.on('data', (d) => err.push(d.toString()));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
  assert.match(err.join(''), /BUNNY_IMMUTABLE_PREFIXES/);
});
