#!/usr/bin/env node
// Publish a static build to Bunny: the step every site's run-build.sh ends with,
// after its own build has written <public-dir>.
//
//   1. The pull zone's browser cache policy, set and read back.
//   2. Redirect pages for moved content (redirects.mjs).
//   3. The files, synced to the storage zone (bunny-sync.mjs).
//   4. The zone's redirect edge rules, replaced with the current set.
//   5. A purge, so the new build is live now rather than when the edge TTL lapses.
//   6. Every redirect checked on the live site.
//
// Every step fails the build. A build that is synced but not purged, or whose
// redirects did not take, is not a published build, and only a failure is seen.
//
// Usage: node publish.mjs <public-dir> <redirects.json>
//
// Required env:
//   BUNNY_STORAGE_ZONE, BUNNY_STORAGE_ENDPOINT, BUNNY_STORAGE_PASSWORD,
//   BUNNY_IMMUTABLE_PREFIXES        see bunny-sync.mjs
//   BUNNY_API_KEY                   account API key (pull zone, edge rules, purge)
//   BUNNY_PULL_ZONE_ID              the pull zone serving the site
//   BUNNY_BROWSER_MAX_AGE           seconds a browser may keep a page
//   BUNNY_PURGE_URL                 e.g. https://<zone>.b-cdn.net/*
//   SITE_ORIGIN                     the canonical origin, e.g. https://example.org
//   SITE_HOSTS                      hosts the site answers on (comma-separated);
//                                   each old path is matched on each
//   SITE_ALIAS_HOSTS                hosts that move to SITE_ORIGIN for good
//                                   (comma-separated; set it empty for none)

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  readRedirects, movedPaths, writeRedirectPages,
  planRedirectRules, planAliasRules, isOwnedRule,
  REDIRECT_STATUS, ALIAS_STATUS,
} from './redirects.mjs';

/** Bunny's limit on edge rules per pull zone. */
export const EDGE_RULE_LIMIT = 50;

/**
 * Replace this builder's edge rules on the zone with `planned`, leaving every
 * other rule as it is. Checked against Bunny's limit first, so a set that will
 * not fit fails before anything is removed.
 *
 * @param {(path: string, opts?: { method?: string, body?: object }) => Promise<any>} api
 */
export async function replaceEdgeRules(api, zoneId, planned) {
  const zone = await api(`/pullzone/${zoneId}`);
  if (!Array.isArray(zone.EdgeRules)) throw new Error(`pull zone ${zoneId}: no EdgeRules in its settings`);
  const owned = zone.EdgeRules.filter(isOwnedRule);
  const others = zone.EdgeRules.length - owned.length;
  if (others + planned.length > EDGE_RULE_LIMIT) {
    throw new Error(
      `pull zone ${zoneId}: ${planned.length} redirect rules and ${others} others exceed Bunny's limit of ${EDGE_RULE_LIMIT}`,
    );
  }
  // Removed first, then added: the redirect pages in the build answer any
  // request that arrives between the two.
  for (const rule of owned) {
    await api(`/pullzone/${zoneId}/edgerules/${rule.Guid}`, { method: 'DELETE' });
  }
  for (const rule of planned) {
    await api(`/pullzone/${zoneId}/edgerules/addOrUpdate`, { method: 'POST', body: rule });
  }
  return { removed: owned.length, added: planned.length };
}

const strip = (url) => (url ?? '').replace(/\/$/, '');

/**
 * Ask the live site for every redirect and check the status and target. Edge
 * rules take a moment to reach every edge, so a miss is asked again before it
 * counts.
 */
export async function checkRedirects(fetchFn, moved, aliasHosts, origin, { attempts = 10, waitMs = 3000 } = {}) {
  const checks = [
    ...moved.map(([from, to]) => ({ url: `${origin}${from}`, status: Number(REDIRECT_STATUS), location: `${origin}${to}` })),
    ...aliasHosts.map((host) => ({ url: `https://${host}/blog`, status: Number(ALIAS_STATUS), location: `${origin}/blog` })),
  ];
  let failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    failures = [];
    for (const check of checks) {
      const res = await fetchFn(check.url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== check.status || strip(location) !== strip(check.location)) {
        failures.push(`${check.url.replace(origin, '')} answered ${res.status} ${location ?? '(no location)'}, want ${check.status} ${check.location}`);
      }
    }
    if (!failures.length) return checks.length;
    if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`redirects not live:\n  ${failures.join('\n  ')}`);
}

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

function bunnyApi(key) {
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`https://api.bunny.net${path}`, {
      method,
      headers: { AccessKey: key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return method === 'GET' ? res.json() : null;
  };
}

function run(cmd, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${args.join(' ')} exited ${code}`))));
  });
}

async function main(publicDir, redirectsFile) {
  const key = required('BUNNY_API_KEY');
  const zoneId = required('BUNNY_PULL_ZONE_ID');
  const maxAge = Number(required('BUNNY_BROWSER_MAX_AGE'));
  const purgeUrl = required('BUNNY_PURGE_URL');
  const origin = required('SITE_ORIGIN').replace(/\/$/, '');
  const hosts = list(required('SITE_HOSTS'));
  if (!('SITE_ALIAS_HOSTS' in env)) throw new Error('SITE_ALIAS_HOSTS must be set (empty for none)');
  const aliasHosts = list(env.SITE_ALIAS_HOSTS);
  const api = bunnyApi(key);

  // Bunny Storage sends no Cache-Control, so the pull zone applies its own
  // default (public, max-age=2592000: thirty days), and a visitor keeps a page
  // from before a deploy for a month. The edge keeps its long TTL: every build
  // purges it. Set on every build and read back, so the zone cannot drift.
  console.log(`=== Pull zone ${zoneId}: browsers keep pages ${maxAge}s ===`);
  await api(`/pullzone/${zoneId}`, { method: 'POST', body: { CacheControlPublicMaxAgeOverride: maxAge } });
  const set = (await api(`/pullzone/${zoneId}`)).CacheControlPublicMaxAgeOverride;
  if (set !== maxAge) throw new Error(`pull zone browser cache is ${set}, not ${maxAge}`);

  console.log('=== Redirect pages for moved content ===');
  const moved = movedPaths(publicDir, readRedirects(redirectsFile));
  writeRedirectPages(publicDir, moved);
  console.log(`  ${moved.length ? moved.map(([f, t]) => `${f} -> ${t}`).join(', ') : 'none'}`);

  console.log(`=== Syncing to Bunny Storage: ${required('BUNNY_STORAGE_ZONE')} ===`);
  await run('node', [resolve(import.meta.dirname, 'bunny-sync.mjs'), publicDir]);

  console.log(`=== Redirect edge rules (moved content ${REDIRECT_STATUS}, alias hosts ${ALIAS_STATUS}) ===`);
  const planned = [...planRedirectRules(moved, { origin, hosts }), ...planAliasRules(aliasHosts, origin)];
  const { removed, added } = await replaceEdgeRules(api, zoneId, planned);
  console.log(`  removed ${removed}, added ${added}`);

  console.log(`=== Purging ${purgeUrl} ===`);
  await api(`/purge?url=${encodeURIComponent(purgeUrl)}&async=false`, { method: 'POST' });

  console.log('=== Checking redirects on the live site ===');
  const checked = await checkRedirects(fetch, moved, aliasHosts, origin);
  console.log(`  ${checked} redirect(s) answer as they should`);
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [publicDir, redirectsFile] = argv.slice(2);
  if (!publicDir || !redirectsFile) {
    console.error('usage: publish.mjs <public-dir> <redirects.json>');
    exit(2);
  }
  main(publicDir, redirectsFile).catch((err) => {
    console.error(`[publish] ${err.message}`);
    exit(1);
  });
}
