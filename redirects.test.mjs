// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import {
  readRedirects,
  movedPaths,
  writeRedirectPages,
  planRedirectRules,
  planAliasRules,
  isOwnedRule,
  REDIRECT_STATUS,
  ALIAS_STATUS,
} from './redirects.mjs';

function setup(redirects) {
  const dir = mkdtempSync(join(os.tmpdir(), 'redirects-'));
  const out = join(dir, 'public');
  mkdirSync(out);
  const file = join(dir, 'redirects.json');
  writeFileSync(file, JSON.stringify(redirects));
  return { out, file };
}

// --- reading redirects.json ------------------------------------------------

test('rejects relative paths', () => {
  const { file } = setup({ 'how-it-works': '/features' });
  assert.throws(() => readRedirects(file), /absolute/);
});

test('rejects the REST API items shape', () => {
  const { file } = setup({ items: [{ path: '/a', 'redirect-to': '/b' }] });
  assert.throws(() => readRedirects(file), /string/);
});

// --- which redirects apply -------------------------------------------------

test('a path the build rendered is not redirected, as in Plone', () => {
  const { out, file } = setup({ '/about': '/features', '/how-it-works': '/features' });
  mkdirSync(join(out, 'about'));
  writeFileSync(join(out, 'about/index.html'), 'real page');
  assert.deepEqual(movedPaths(out, readRedirects(file)), [['/how-it-works', '/features']]);
});

// --- redirect pages --------------------------------------------------------

test('writes a redirect page for each moved path', () => {
  const { out, file } = setup({ '/how-it-works': '/features' });
  writeRedirectPages(out, movedPaths(out, readRedirects(file)));
  const html = readFileSync(join(out, 'how-it-works/index.html'), 'utf8');
  assert.match(html, /<meta http-equiv="refresh" content="0; url=\/features">/);
  assert.match(html, /<link rel="canonical" href="\/features">/);
  assert.match(html, /<a href="\/features">/);
});

test('never overwrites a page the build rendered', () => {
  const { out, file } = setup({ '/about': '/features' });
  mkdirSync(join(out, 'about'));
  writeFileSync(join(out, 'about/index.html'), 'real page');
  writeRedirectPages(out, movedPaths(out, readRedirects(file)));
  assert.equal(readFileSync(join(out, 'about/index.html'), 'utf8'), 'real page');
  assert.equal(existsSync(join(out, 'about.html')), false);
});

// --- edge rules ------------------------------------------------------------

const site = { origin: 'https://example.org', hosts: ['example.org', 'example.b-cdn.net'] };

test('moved content redirects with the status Plone uses: 302', () => {
  // plone.app.redirector answers a GET for a moved path with 302 Found: a
  // redirect stops applying as soon as content exists at the old path again,
  // so it is not permanent.
  assert.equal(REDIRECT_STATUS, '302');
  const [rule] = planRedirectRules([['/security', '/features/security']], site);
  assert.equal(rule.ActionType, 1);
  assert.equal(rule.ActionParameter1, 'https://example.org/features/security');
  assert.equal(rule.ActionParameter2, '302');
});

test('a rule matches the old path on the site\'s own hosts only', () => {
  // Bunny patterns are anchored at the end only. `*/security` would also match
  // /features/security, the redirect's own target, and loop.
  const [rule] = planRedirectRules([['/security', '/features/security']], site);
  const patterns = rule.Triggers.flatMap((t) => t.PatternMatches);
  assert.deepEqual(patterns.sort(), [
    'https://example.b-cdn.net/security',
    'https://example.b-cdn.net/security/',
    'https://example.org/security',
    'https://example.org/security/',
  ]);
  assert.ok(patterns.every((p) => !p.startsWith('*')));
});

test('sources with one target share a rule, within Bunny\'s pattern limits', () => {
  // Bunny allows 5 patterns per trigger and 5 triggers per rule, and 50 rules
  // per pull zone, so redirects to one target are grouped.
  const moved = Array.from({ length: 13 }, (_, i) => [`/old-${i}`, '/new']);
  const rules = planRedirectRules(moved, site);
  for (const rule of rules) {
    assert.ok(rule.Triggers.length <= 5, 'at most 5 triggers per rule');
    for (const t of rule.Triggers) assert.ok(t.PatternMatches.length <= 5, 'at most 5 patterns per trigger');
  }
  const covered = rules.flatMap((r) => r.Triggers.flatMap((t) => t.PatternMatches));
  assert.equal(covered.length, 13 * 2 * 2, 'every source, with and without a slash, on both hosts');
  assert.ok(rules.length < 13, 'grouped, not one rule per source');
});

test('an alias host moves permanently, with its path: 301', () => {
  assert.equal(ALIAS_STATUS, '301');
  const [rule] = planAliasRules(['www.example.co.uk'], 'https://www.example.com');
  assert.equal(rule.ActionParameter1, 'https://www.example.com{{path}}');
  assert.equal(rule.ActionParameter2, '301');
  assert.deepEqual(rule.Triggers[0].PatternMatches, ['https://www.example.co.uk/*']);
});

test('the rules this builder owns are recognised, and no others', () => {
  for (const rule of [
    ...planRedirectRules([['/a', '/b']], site),
    ...planAliasRules(['www.example.org'], 'https://example.com'),
  ]) {
    assert.ok(isOwnedRule(rule), rule.Description);
  }
  // an earlier sync's tag tagged its rules `redirect: `; they are
  // replaced, not left alongside the new ones.
  assert.ok(isOwnedRule({ Description: 'redirect: -> /company' }));
  assert.equal(isOwnedRule({ Description: 'Force SSL' }), false);
  assert.equal(isOwnedRule({ Description: null }), false);
});

// --- query strings ------------------------------------------------------------

test('a redirect from a query string is always moved, and gets no page', () => {
  // A static file cannot be keyed on a query string, so there is never a
  // rendered page to win, and no redirect page can be written for it.
  const { out, file } = setup({ '/case-studies?facet.Subject=crm': '/case-studies?facet.Subject=custom-apps' });
  mkdirSync(join(out, 'case-studies'));
  writeFileSync(join(out, 'case-studies/index.html'), 'the listing');
  const moved = movedPaths(out, readRedirects(file));
  assert.deepEqual(moved, [['/case-studies?facet.Subject=crm', '/case-studies?facet.Subject=custom-apps']]);
  writeRedirectPages(out, moved);
  assert.equal(readFileSync(join(out, 'case-studies/index.html'), 'utf8'), 'the listing');
  assert.equal(existsSync(join(out, 'case-studies?facet.Subject=crm')), false);
});

test('a query redirect needs both its path and its query', () => {
  // Bunny's URL trigger ignores the query string, so the query is a trigger of
  // its own, and both must match: the bare path is the listing, not a redirect.
  const rules = planRedirectRules(
    [['/case-studies?facet.Subject=crm', '/case-studies?facet.Subject=custom-apps'], ['/old', '/new']],
    site,
  );
  const query = rules.find((r) => r.Triggers.some((t) => t.Type === 6));
  assert.equal(query.TriggerMatchingType, 1, 'all triggers must match');
  assert.equal(query.ActionParameter1, 'https://example.org/case-studies?facet.Subject=custom-apps');
  assert.equal(query.ActionParameter2, '302');
  const url = query.Triggers.find((t) => t.Type === 0);
  assert.deepEqual(url.PatternMatches.sort(), [
    'https://example.b-cdn.net/case-studies',
    'https://example.b-cdn.net/case-studies/',
    'https://example.org/case-studies',
    'https://example.org/case-studies/',
  ]);
  const qs = query.Triggers.find((t) => t.Type === 6);
  assert.deepEqual(qs.PatternMatches, ['?facet.Subject=crm']);
  // The plain redirect is unaffected, and never shares a rule with the query one.
  const plain = rules.find((r) => r !== query);
  assert.equal(plain.TriggerMatchingType, 0);
  assert.ok(plain.Triggers.every((t) => t.Type === 0));
});
