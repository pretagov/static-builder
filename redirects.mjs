// Moved content on a static site: redirect pages in the build, and Bunny edge
// rules that answer with a real redirect status.
//
// redirects.json ({ "/old": "/new" }, site-relative) is the plone.exportimport
// sibling a site imports into Plone's redirector. Plone answers a moved path
// itself; a static site on a CDN has no Plone in front of it, so the builder
// carries the same redirects in two forms:
//
//   - A redirect page at <old>/index.html (meta refresh + canonical link). It
//     works on any static host, and it covers the moment between the old edge
//     rules being removed and the new ones being added.
//   - An edge rule per target on the pull zone, which answers with the status
//     Plone would send.
//
// Both follow Plone's rule that a redirect applies only once nothing lives at
// the old path: a page the build rendered there wins.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The status for moved content. plone.app.redirector answers a GET for a moved
 * path with 302 Found (and 307 for other methods): a redirect stops applying as
 * soon as content exists at the old path again, so it is not permanent.
 */
export const REDIRECT_STATUS = '302';

/**
 * The status for an alias host (www.example.co.uk -> www.example.com). This is
 * domain canonicalisation, not moved content, and Plone never sends it: the
 * domain has moved for good.
 */
export const ALIAS_STATUS = '301';

// Bunny's limits: 5 patterns per trigger, 5 triggers per rule.
const PATTERNS_PER_TRIGGER = 5;
const TRIGGERS_PER_RULE = 5;
const PATTERNS_PER_RULE = PATTERNS_PER_TRIGGER * TRIGGERS_PER_RULE;

// The descriptions this builder writes, so it can tell its own rules from the
// site's others. `redirect: ` is what an earlier version of the sync wrote; its
// rules are replaced too, rather than left alongside these.
const MOVED_PREFIX = 'redirects.json: ';
const ALIAS_PREFIX = 'alias host: ';
const OWNED_PREFIXES = [MOVED_PREFIX, ALIAS_PREFIX, 'redirect: '];

/** @returns {Record<string, string>} the validated { "/old": "/new" } map */
export function readRedirects(redirectsFile) {
  const map = JSON.parse(readFileSync(redirectsFile, 'utf8'));
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${redirectsFile}: must be a {"/old": "/new"} object`);
  }
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== 'string') {
      throw new Error(`${redirectsFile}: target for ${JSON.stringify(from)} must be a string path`);
    }
    if (!from.startsWith('/') || !to.startsWith('/')) {
      throw new Error(`${redirectsFile}: paths must be absolute: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    }
  }
  return map;
}

const pageFor = (publicDir, path) => join(publicDir, path.replace(/^\/+|\/+$/g, ''), 'index.html');

const hasQuery = (path) => path.includes('?');

// An immediate meta refresh: a page that only sends the visitor on. Frameworks
// write these for their own redirects (Nuxt does, for every routeRules
// redirect), and a page of content never refreshes at once.
const STUB = /<meta\s+http-equiv=["']?refresh["']?\s+content=["']?0\s*[;"']/i;

/** True when the build rendered real content at `path`, not a redirect stub. */
function rendered(publicDir, path) {
  const page = pageFor(publicDir, path);
  return existsSync(page) && !STUB.test(readFileSync(page, 'utf8'));
}

/**
 * The redirects that apply: those whose old path the build did not render.
 * Decided once, before any redirect page is written, so a redirect page is
 * never mistaken for a rendered one. A redirect stub is not a rendered page.
 * A path with a query string always applies: a static file cannot be keyed on
 * a query, so nothing the build wrote can be at it.
 *
 * @returns {[string, string][]}
 */
export function movedPaths(publicDir, map) {
  return Object.entries(map).filter(([from]) => hasQuery(from) || !rendered(publicDir, from));
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function redirectPage(to) {
  const href = escapeAttr(to);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved</title>
<link rel="canonical" href="${href}">
<meta http-equiv="refresh" content="0; url=${href}">
<meta name="robots" content="noindex">
</head>
<body>
<p>This page has moved to <a href="${href}">${href}</a>.</p>
</body>
</html>
`;
}

export function writeRedirectPages(publicDir, moved) {
  for (const [from, to] of moved) {
    // A query string cannot name a file; the edge rule alone answers for it.
    if (hasQuery(from)) continue;
    const page = pageFor(publicDir, from);
    mkdirSync(join(page, '..'), { recursive: true });
    writeFileSync(page, redirectPage(to));
  }
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const URL_TRIGGER = 0;
const QUERY_TRIGGER = 6;

function trigger(type, matches) {
  return { Type: type, PatternMatchingType: 0 /* any pattern */, PatternMatches: matches, Parameter1: null };
}

function rule({ description, target, status, patterns }) {
  return {
    ActionType: 1, // Redirect
    ActionParameter1: target,
    ActionParameter2: status,
    Enabled: true,
    Description: description,
    TriggerMatchingType: 0, // any trigger
    Triggers: chunk(patterns, PATTERNS_PER_TRIGGER).map((matches) => trigger(URL_TRIGGER, matches)),
  };
}

const pathPatterns = (path, hosts) =>
  hosts.flatMap((host) => [`https://${host}${path}`, `https://${host}${path.replace(/\/+$/, '')}/`]);

/**
 * One rule for a redirect from a path with a query string. Bunny's URL trigger
 * ignores the query, so the query is a trigger of its own and the rule needs
 * both: without the query the path is a page (a listing, say), not a redirect.
 */
function queryRule(from, to, { origin, hosts }) {
  const [path, query] = from.split(/\?(.*)/s);
  const patterns = pathPatterns(path, hosts);
  if (patterns.length > PATTERNS_PER_TRIGGER) {
    throw new Error(`planRedirectRules: ${from} needs ${patterns.length} path patterns in one trigger, over Bunny's ${PATTERNS_PER_TRIGGER}`);
  }
  return {
    ...rule({ description: `${MOVED_PREFIX}${from} -> ${to}`.slice(0, 255), target: `${origin}${to}`, status: REDIRECT_STATUS, patterns: [] }),
    TriggerMatchingType: 1, // every trigger
    Triggers: [trigger(URL_TRIGGER, patterns), trigger(QUERY_TRIGGER, [`?${query}`])],
  };
}

/**
 * Edge rules for moved content: one per target, holding every old path that
 * leads there (in more than one rule when they exceed Bunny's pattern limits).
 *
 * Each old path is matched with and without a trailing slash on each of the
 * site's own hosts. Never a leading wildcard: Bunny anchors a pattern at the
 * end only, so a wildcard followed by `/security` would also match
 * `/features/security`, the very target, and loop. A path with a query string
 * gets a rule of its own (see queryRule).
 *
 * @param {[string, string][]} moved
 * @param {{ origin: string, hosts: string[] }} site
 */
export function planRedirectRules(moved, { origin, hosts }) {
  if (!hosts.length) throw new Error('planRedirectRules: no hosts to match on');
  const rules = moved.filter(([from]) => hasQuery(from)).map(([from, to]) => queryRule(from, to, { origin, hosts }));
  const byTarget = new Map();
  for (const [from, to] of moved) {
    if (hasQuery(from)) continue;
    if (!byTarget.has(to)) byTarget.set(to, []);
    byTarget.get(to).push(from);
  }
  const perSource = hosts.length * 2;
  if (perSource > PATTERNS_PER_RULE) {
    throw new Error(`planRedirectRules: ${hosts.length} hosts need ${perSource} patterns per path, over Bunny's ${PATTERNS_PER_RULE} per rule`);
  }
  const sourcesPerRule = Math.floor(PATTERNS_PER_RULE / perSource);
  for (const [to, froms] of byTarget) {
    for (const batch of chunk(froms, sourcesPerRule)) {
      const patterns = batch.flatMap((from) => pathPatterns(from, hosts));
      rules.push(rule({
        description: `${MOVED_PREFIX}${batch.join(', ')} -> ${to}`.slice(0, 255),
        target: `${origin}${to}`,
        status: REDIRECT_STATUS,
        patterns,
      }));
    }
  }
  return rules;
}

/** Edge rules that send each alias host to the canonical origin, path kept. */
export function planAliasRules(aliasHosts, origin) {
  return aliasHosts.map((host) => rule({
    description: `${ALIAS_PREFIX}${host} -> ${origin}`,
    target: `${origin}{{path}}`,
    status: ALIAS_STATUS,
    patterns: [`https://${host}/*`],
  }));
}

/** True for an edge rule this builder wrote (and so may replace). */
export function isOwnedRule(edgeRule) {
  const description = edgeRule.Description ?? '';
  return OWNED_PREFIXES.some((prefix) => description.startsWith(prefix));
}
