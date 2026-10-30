# static-builder

Rebuilds a static site when its Plone publishes, and puts it on Bunny.

Each site runs this on a Fly app of its own that suspends when idle. Plone's
webhook wakes it, `server.mjs` runs the site's `run-build.sh`, and that script
does the site's own build and then calls `publish.mjs`.

It replaces copies that each site used to keep in its own repo, which had
drifted apart: a fix in one never reached the others.

| File | What it does |
| --- | --- |
| `server.mjs` | The webhook receiver. One build at a time, saves during a build coalesce into one more, a watchdog with one retry, a held-open connection so Fly does not suspend the machine mid-build, and the failed build's last output on `/healthz`. |
| `publish.mjs` | Run after the site's build. Sets the pull zone's browser cache, writes redirect pages, syncs the files, replaces the redirect edge rules, purges, then checks every redirect on the live site. Every step fails the build. |
| `bunny-sync.mjs` | Diff-based upload to a Bunny Storage zone. Hashed assets first, pages last; old hashed assets kept for edge-cached pages; stale pages removed. |
| `redirects.mjs` | Moved content from `redirects.json`: redirect pages, and the edge rules that answer for them. |

## Using it in a site

Add it as a submodule at `static-builder/`, copy it into the builder image, and
end the site's `run-build.sh` with:

```sh
node /app/static-builder/publish.mjs <public-dir> <redirects.json>
```

The image runs `node /app/static-builder/server.mjs`, with `BUILD_SCRIPT` set to
the site's `run-build.sh`.

## Settings

All required. Nothing defaults to one site's values.

| Variable | |
| --- | --- |
| `BUILDER_WEBHOOK_SECRET` | The path token Plone posts to (`/build/<secret>`). |
| `BUILDER_PUBLIC_URL` | This builder's own `https://<app>.fly.dev`, for the keepalive. |
| `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_ENDPOINT`, `BUNNY_STORAGE_PASSWORD` | The storage zone. |
| `BUNNY_IMMUTABLE_PREFIXES` | The framework's hashed asset folders: `_nuxt/,edit/_nuxt/` for Nuxt, `_next/static/` for Next.js. |
| `BUNNY_API_KEY` | Account API key: pull zone settings, edge rules, purge. |
| `BUNNY_PULL_ZONE_ID` | The pull zone serving the site. |
| `BUNNY_BROWSER_MAX_AGE` | Seconds a browser may keep a page. |
| `BUNNY_PURGE_URL` | What to purge, e.g. `https://<zone>.b-cdn.net/*`. |
| `SITE_ORIGIN` | The canonical origin, e.g. `https://example.org`. |
| `SITE_HOSTS` | Every host the site answers on, comma-separated. |
| `SITE_ALIAS_HOSTS` | Hosts that move to `SITE_ORIGIN` for good, comma-separated. Set it empty for none. |

`BUILD_SCRIPT` (`./run-build.sh`), `MAX_BUILD_MS` (30 minutes) and
`BUNNY_SYNC_PARALLEL` (16) have defaults, none of them any one site's.

## Redirects

Moved content answers with **302**, the status Plone itself sends:
plone.app.redirector answers a GET for a moved path with 302 Found, because a
redirect stops applying as soon as content exists at the old path again.

An alias host (`www.example.co.uk` to `www.example.com`) answers with **301**.
That is a domain that has moved for good, which Plone never handles.

Each moved path is matched on the site's own hosts, with and without a
trailing slash. Never with a leading wildcard: Bunny anchors a pattern at the
end only, so a wildcard before `/security` would also match
`/features/security`, the redirect's own target, and loop.

As in Plone, a redirect applies only where the build rendered nothing: a real
page at the old path wins. A redirect stub is not a real page: a framework that
handles its own redirects (Nuxt's routeRules) writes an instant meta-refresh
page at each old path, which answers 200 where the redirect should answer 302,
so the edge rule is still made. A redirect page is written at the old path
too, so it still works on a host without edge rules and between the old rules
being removed and the new ones added.

Bunny's URL trigger ignores the query string. A redirect from a path with a
query (`/case-studies?facet.Subject=crm`) gets a rule of its own that needs
both the path and a Query String trigger; without the query the path is a
page, not a redirect. No redirect page can be written for it, since a static
file cannot be keyed on a query.

Bunny allows 50 edge rules per pull zone, 5 triggers per rule and 5 patterns
per trigger. Paths that share a target share a rule, and a set that would not
fit fails before any rule is removed.

## Tests

```sh
node --test
```
