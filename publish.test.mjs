// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replaceEdgeRules, checkRedirects, EDGE_RULE_LIMIT } from './publish.mjs';
import { planRedirectRules } from './redirects.mjs';

const site = { origin: 'https://example.org', hosts: ['example.org'] };

/** A pull zone's edge rules behind a stand-in for the Bunny API. */
function fakeZone(rules) {
  const state = { rules: rules.map((r, i) => ({ Guid: `g${i}`, ...r })), calls: [] };
  const api = async (path, { method = 'GET', body } = {}) => {
    state.calls.push(`${method} ${path}`);
    if (method === 'GET') return { EdgeRules: state.rules };
    if (method === 'DELETE') {
      const guid = path.split('/').pop();
      state.rules = state.rules.filter((r) => r.Guid !== guid);
      return null;
    }
    state.rules.push({ Guid: `new${state.rules.length}`, ...body });
    return null;
  };
  return { api, state };
}

test('replaces the rules it owns and leaves the site\'s others alone', async () => {
  const { api, state } = fakeZone([
    { Description: 'Force SSL', ActionType: 0 },
    { Description: 'redirects.json: /old -> /gone', ActionType: 1 },
    { Description: 'redirect: -> /company', ActionType: 1 }, // an earlier sync's tag
  ]);
  const planned = planRedirectRules([['/security', '/features/security']], site);
  await replaceEdgeRules(api, 1, planned);

  const descriptions = state.rules.map((r) => r.Description).sort();
  assert.deepEqual(descriptions, ['Force SSL', 'redirects.json: /security -> /features/security']);
});

test('refuses, before removing anything, a set that would pass Bunny\'s rule limit', async () => {
  const others = Array.from({ length: EDGE_RULE_LIMIT - 1 }, (_, i) => ({ Description: `site rule ${i}` }));
  const { api, state } = fakeZone([...others, { Description: 'redirects.json: /a -> /b' }]);
  const planned = planRedirectRules([['/x', '/one'], ['/y', '/two']], site);

  await assert.rejects(() => replaceEdgeRules(api, 1, planned), /limit/);
  assert.deepEqual(state.calls, ['GET /pullzone/1'], 'nothing was deleted or added');
});

/** Responses keyed by URL, as fetch with redirect: 'manual' would see them. */
function fakeFetch(responses) {
  return async (url) => {
    const r = responses[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return { status: r.status, headers: { get: (h) => (h.toLowerCase() === 'location' ? r.location ?? null : null) } };
  };
}

test('a redirect that answers with Plone\'s status and target passes', async () => {
  const fetchFn = fakeFetch({ 'https://example.org/security': { status: 302, location: 'https://example.org/features/security' } });
  await checkRedirects(fetchFn, [['/security', '/features/security']], [], site.origin, { attempts: 1 });
});

test('a redirect with the wrong status fails, saying which', async () => {
  const fetchFn = fakeFetch({ 'https://example.org/security': { status: 301, location: 'https://example.org/features/security' } });
  await assert.rejects(
    () => checkRedirects(fetchFn, [['/security', '/features/security']], [], site.origin, { attempts: 1 }),
    /\/security .*301.*want 302/,
  );
});

test('an alias host must send its path on to the origin with a 301', async () => {
  const ok = fakeFetch({ 'https://www.example.co.uk/blog': { status: 301, location: 'https://www.example.com/blog' } });
  await checkRedirects(ok, [], ['www.example.co.uk'], 'https://www.example.com', { attempts: 1 });
  const lost = fakeFetch({ 'https://www.example.co.uk/blog': { status: 301, location: 'https://www.example.com/' } });
  await assert.rejects(
    () => checkRedirects(lost, [], ['www.example.co.uk'], 'https://www.example.com', { attempts: 1 }),
    /www\.example\.co\.uk/,
  );
});
