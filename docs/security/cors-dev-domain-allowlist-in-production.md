# SECURITY FINDING — production auto-allows any `*.kirk.replit.dev` origin, and the code says it cannot

**Filed 2026-08-15. Open. Severity: LOW-TO-MODERATE and LATENT.**

Found while establishing whether the Phase B3 probe could run from a local
frontend. Not a Phase B issue and filed separately.

> **Read the severity section before acting.** This is **not** an active session-
> theft hole today, and it is **not** nothing. It is a control that is weaker than
> the code claims, whose severity is currently held down by an unrelated
> implementation detail that nobody wrote down as load-bearing.

---

## The centrepiece: a comment that is empirically false

`artifacts/api-server/src/app.ts:46-49`:

```
// Auto-allow the Replit workspace dev domain and any port-mapped subdomains
// (e.g. https://<id>.expo.kirk.replit.dev for the Expo web preview).
// REPLIT_DEV_DOMAIN is only present in the Replit workspace, never in the
// deployed production environment, so this is a dev-only convenience.
```

**"never in the deployed production environment" is false. Production has it
set.**

Everything else follows from that single wrong sentence. The allowlist code is
doing exactly what it was written to do; the deployment does not match the
environment the author believed they were writing for, and **nothing anywhere
detects the difference.**

This is the same family as the swallowed-failure defects already recorded on this
workstream: **a safety property that stopped being true, with nothing watching.**
It is the part most likely to mislead the next reader, because the comment is
reassuring, specific, and sitting directly above the code it describes.

---

## MEASURED — against production, 2026-08-15

Requests to `https://portava.replit.app/api/places/search?q=Barcelona` with
varying `Origin`:

| Origin sent | HTTP | `access-control-allow-origin` | `credentials` |
|---|---|---|---|
| `https://portava.replit.app` | 200 | echoed | true |
| `https://abc123.kirk.replit.dev` | 200 | echoed | true |
| `https://abc123.expo.kirk.replit.dev` | 200 | echoed | true |
| **`https://totally-random-xyz-9999.kirk.replit.dev`** | **200** | **echoed** | **true** |
| **`https://attacker-controlled.kirk.replit.dev`** | **200** | **echoed** | **true** |
| `https://foo.bar.kirk.replit.dev` | 200 | echoed | true |
| `https://evil.example.com` | **500** | none | — |
| `https://notkirk.replit.dev` | **500** | none | — |
| `https://kirk.replit.dev` (bare parent) | **500** | none | — |
| *(no Origin header)* | 200 | none | — |

### Why the probe was designed this way

The two **invented** subdomains are the load-bearing evidence. They cannot be in
any explicit allowlist — nobody has ever typed them — so a 200 with the origin
echoed back proves the match is **pattern-based on the parent domain**, not an
enumerated list.

The two **near-miss** origins are the control. `notkirk.replit.dev` and the bare
`kirk.replit.dev` are both correctly **rejected**, which shows the `endsWith`
check is properly anchored on the leading dot. **The wildcard is wide, but it is
not broken** — and separating those two questions is the point of running both.

Consequently `REPLIT_DEV_DOMAIN` **is** set in the production deployment, since
the pattern branch (`app.ts:72-79`) is the only code path that could produce
these results.

---

## Impact

`kirk.replit.dev` is a **shared, multi-tenant parent domain** — other people's
Repls are hosted on it. Production therefore accepts **credentialed** cross-origin
requests from an entire domain the project does not control.

### Severity: LOW-TO-MODERATE, and LATENT — stated precisely

**Why it is not worse today.** Authentication is **Bearer-token only**
(`lib/http.ts:145,178` — `req.headers.authorization`, `Bearer ` prefix), and
there are **no cookie sessions anywhere in the api-server** (no `cookie-parser`,
no `express-session`, no `res.cookie`, no `req.cookies`). So
`credentials: true` does **not** hand a hostile origin an automatic authenticated
session: a browser will not attach an `Authorization` header by itself, and a
malicious origin cannot read a token out of another origin's storage. An attacker
page would need a token it already has — at which point CORS is not what is
protecting anything.

**Why it is still real.** The control is weaker than the code claims, on a
production surface, and its harmlessness rests entirely on an implementation
detail nobody recorded as security-relevant.

### The trigger — the sentence to act on

> **The moment cookie-based authentication is introduced, this becomes serious
> immediately and without further change.** `credentials: true` plus a
> wildcarded multi-tenant origin plus a session cookie is credentialed
> cross-origin access from any Repl on a shared domain.

Whoever adds cookie auth will not be looking at `app.ts`, and the comment there
tells them this cannot happen in production. **That is the collision worth
preventing.**

---

## Suggested fix, NOT applied

Filing and fixing in one motion is how a defect report becomes an unreviewed
change. In priority order:

1. **Fix the comment first, whatever else is decided.** It is actively
   misleading, it costs nothing, and it is what the next reader will trust.
2. **Set `ALLOWED_ORIGINS` explicitly in the production deployment.** The code
   already prefers it over the fallback (`app.ts:35`), and setting it makes the
   production allowlist an enumerated list. Note the fallback path *already logs a
   warning* that it is in use — worth checking whether that warning is firing in
   production and being ignored, which would make this a **third** instance of a
   signal that existed and was not read.
3. **Gate the dev-domain branch on more than the presence of `REPLIT_DEV_DOMAIN`.**
   The variable is evidently not the production/dev discriminator the code
   assumes. An explicit `NODE_ENV !== 'production'` check, or an opt-in flag,
   would make the intent enforceable rather than incidental.
4. **Add a check that fails if production resolves a wildcard origin.** The
   defect is not that someone chose a wide allowlist — it is that **nobody could
   tell it was wide**. A test asserting an invented subdomain is *rejected* would
   have caught this the day the deployment changed.

**Note the deliberate non-action:** the Phase B3 probe needed a local frontend to
reach production, and the obvious route was to add its origin to
`ALLOWED_ORIGINS`. That was **refused** — widening an already over-permissive
production allowlist to make a test convenient is the wrong direction. A
dev-only same-origin proxy was built instead
(`travel-buddy-standalone/scripts/dev-same-origin-proxy.mjs`), which needs **no
production change at all**.

---

## Reproduce

```bash
for O in https://totally-random-xyz-9999.kirk.replit.dev \
         https://evil.example.com \
         https://notkirk.replit.dev; do
  printf '%-46s ' "$O"
  curl -s -m 20 -o /dev/null -D - -H "Origin: $O" \
    'https://portava.replit.app/api/places/search?q=Barcelona' \
  | awk 'BEGIN{IGNORECASE=1;c="";a="none"} /^HTTP/{c=$2} /^access-control-allow-origin/{a=$2} END{printf "http=%s ACAO=%s\n",c,a}'
done
```

Expected today: the first returns **200 with the origin echoed**; the other two
return **500 with no ACAO**.

**When this is fixed, the first line must join the other two.**
