# ADR 0006: Persistent Node API for local development

Date: 2026-08-26
Status: Accepted

## Context

ADR 0001 chose Vercel Functions for the deployed backdrop, tint and album-credit
APIs. The local full-stack preview originally ran those Functions through
`vercel dev` so the browser could use the same `/api/backdrop`, `/api/tint` and
`/api/credit` paths as production.

That platform emulation was a poor fit for the interactive development loop:

- Vercel Dev built and started a comparatively heavy `@vercel/node` Function
  worker for individual requests. One player legitimately makes several related
  requests while prefetching the queue and revalidating an artistless result with
  the authoritative now-playing artist, so this overhead accumulated even though
  only one browser was open.
- `start_test_server.ps1` copied `api/` into a temporary Vercel workspace once.
  The existing site watcher observed `site/`, but resolver edits did not reliably
  reach that workspace or invalidate Vercel Dev's bundled CommonJS dependencies.
- Local query parsing could expose form-encoded spaces as literal plus signs.
  A browser URL such as `album=Defiance+%28Video+Game%29` could therefore reach
  the resolver differently from the already-decoded strings used by unit tests.
- Repeated attempts to invalidate the local bundle with nonces, temporary module
  names or post-start file touches depended on undocumented builder behavior and
  did not provide a maintainable development contract.

Production still benefits from Vercel's Functions, edge caching and platform
protections. The problem is limited to using full platform emulation as the local
request loop.

## Decision

Use a small persistent Node HTTP adapter for local development instead of
`vercel dev`.

`installer/local_api_server.js`:

- maps `/api/backdrop`, `/api/tint` and `/api/credit` directly to the same exported
  handler functions used by the Vercel entrypoints;
- constructs `req.query` with the standard `URL` and `URLSearchParams` APIs, so
  form-encoded `+` spaces and percent-encoded literal plus signs have their normal
  meanings;
- otherwise passes the native Node request and response objects to the handlers,
  preserving their method, CORS, validation and response behavior;
- returns a JSON 404 for paths outside the three local API routes; and
- forces `Cache-Control: no-store` on local responses so a browser cannot conceal
  a resolver fix behind the production cache lifetime.

`start_test_server.ps1` starts this adapter with Node's watch mode and explicitly
watches both `api/` and the adapter itself. A source change restarts the warm API
process automatically. The launcher continues to load provider credentials from
`.env.local`, restrict CORS to the configured local site origin, retain structured
provider logs and stop the complete process tree with the site preview.

The adapter must remain thin. Title cleanup, media classification, provider
selection, ratings, URL validation, tint calculation and response shaping stay in
`api/_lib/backdrop.js` and `api/_lib/credit.js`; no resolver rule may be copied into
the local server.

This decision changes local development only. Production and preview deployments
continue to use the Vercel entrypoints, Vercel environment variables, WAF rules and
edge-cache headers described by ADR 0001.

## Consequences

- Local requests no longer pay a Function build/start cost. A cold artwork lookup
  can still take roughly 0.6–1.0 seconds because it performs real provider searches,
  downloads a tint thumbnail and decodes that image; this is upstream work rather
  than local server overhead.
- Resolver edits automatically restart the local API and are visible without
  maintaining a temporary workspace, restarting the complete preview or manually
  changing `resolver_version`.
- The local launcher requires Node.js and installed project dependencies, but no
  longer requires the Vercel CLI, `pnpm dlx` or `npx`.
- Local browser caching intentionally differs from production. Resolver caching is
  still covered by handler tests and the renderer-derived `resolver_version`, while
  deployed Vercel previews remain the place to validate edge-cache behavior.
- The local adapter cannot reproduce every Vercel platform detail. Deployment
  configuration, runtime compatibility, WAF behavior and provider access from
  Vercel egress must still be verified in a Vercel Preview before production.
- An API edit may terminate an in-flight local provider request during the watch
  restart. The player already treats endpoint failures as retryable, and preserving
  stale work would be counterproductive during resolver development.

## Alternatives considered

- **Keep Vercel Dev and restart it whenever `api/` changes.** Better than a stale
  temporary copy, but it retains the per-request worker overhead and the local
  parsing/bundling differences that caused the problem.
- **Synchronize source files into the temporary workspace and force bundle
  invalidation.** Rejected. It relies on implementation details such as builder
  hashes, watcher timing and dependency-cache boundaries.
- **Use mocked providers for the local player.** Useful for deterministic browser
  tests, but insufficient for interactive verification of credentials, live search
  results, provider latency, CDN URLs and image tinting.
- **Move resolver logic into the local server.** Rejected. The adapter would drift
  from production and violate the shared server-side resolver boundary established
  by ADR 0001 and ADR 0002.

## Implementation

Implemented on 2026-08-26:

- `installer/local_api_server.js` provides the persistent local route adapter.
- `installer/local_api_server.test.js` covers browser query decoding, cache
  disabling and unknown routes.
- `start_test_server.ps1` runs the adapter under Node watch mode and keeps the
  existing local site renderer and watcher.
- `site/README.md` documents the local/production boundary and debug controls.
