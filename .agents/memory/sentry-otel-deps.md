---
name: Sentry OpenTelemetry deps not hoisted by pnpm
description: @sentry/node externalises ~31 @opentelemetry/* packages at build time; pnpm does not auto-hoist them into api-server/node_modules, so they must be declared explicitly or the server crashes on startup.
---

## The rule
After adding or upgrading `@sentry/node` in `artifacts/api-server`, all `@opentelemetry/*` packages listed in `@sentry/node`'s own `dependencies` must be explicitly added to `artifacts/api-server/package.json` at matching version ranges, because `build.mjs` externalises `@opentelemetry/*` (line 65) and pnpm's isolated store does not hoist them automatically.

**Why:** `@sentry/node` dynamically requires its OpenTelemetry instrumentation packages at runtime. esbuild cannot bundle dynamic requires, so `build.mjs` already externalises `@opentelemetry/*`. That means Node must find them on disk at startup. pnpm only links packages explicitly listed as direct deps of the workspace package — transitive deps of `@sentry/node` are not surfaced.

**How to apply:** When bumping `@sentry/node`, run:
```
node -e "const p=require('./node_modules/@sentry/node/package.json'); Object.entries(p.dependencies||{}).filter(([k])=>k.startsWith('@opentelemetry')||k==='@sentry/opentelemetry').forEach(([k,v])=>console.log(k+'@'+v))"
```
then `pnpm add` each printed package at the printed version range. The exact versions that caused the last outage were the `@sentry/node@8.55.x` bundle requiring `@opentelemetry/resources@^1.30.1` but getting v2.x from the latest pnpm resolution.
