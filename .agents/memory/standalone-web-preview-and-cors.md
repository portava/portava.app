---
name: travel-buddy-standalone web preview access + CORS
description: How to actually browser-test travel-buddy-standalone's web build (not the frozen artifacts/travel-buddy tree), and the CORS fix required to make it work.
---

`travel-buddy-standalone`'s web dev server binds to `localhost:3000` inside the
container and is **not a registered artifact** — it has no default
browser-facing preview URL. If a testing subagent is given no explicit URL, it
will default to the Expo tunnel/preview domain, which serves the legacy-frozen
`artifacts/travel-buddy` tree instead (that tree is archived at `bc1bef404`, so this failure mode is now impossible). This causes fixes made in
`travel-buddy-standalone` to appear not to work — cache clears, workflow
restarts, and "new browser context" all fail to help because the tester was
never hitting the right tree.

**How to apply:** when a fix in `travel-buddy-standalone` needs live browser
verification:
1. Use `https://$REPLIT_DEV_DOMAIN:3000/` (port suffix directly on the dev
   domain) as the URL — confirmed reachable (HTTP 200). Other guessed
   subdomain/port-prefix patterns 404.
2. This origin will be rejected by the api-server's dev CORS allowlist unless
   it explicitly allows `https://${REPLIT_DEV_DOMAIN}:<any-port>`, not just
   the bare dev domain or its subdomains — add that allowance in
   `artifacts/api-server/src/app.ts`'s dev-only CORS origin check if missing.
3. Always tell the testing subagent this exact URL up front rather than
   letting it default to the Expo tunnel domain.
