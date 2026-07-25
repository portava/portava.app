#!/usr/bin/env python3
"""
Portava audit close-out — applies the verified server-side fixes in place.
Idempotent: safe to re-run (each edit is skipped if already applied).
Run from ~/workspace/artifacts/api-server:
    python3 apply-portava-audit-closeout.py
"""
import json, re, sys, os

def edit(path, old, new, label, required=True):
    s = open(path, encoding="utf-8").read()
    if new in s:
        print(f"  = {label}: already applied"); return
    c = s.count(old)
    if c == 0:
        print(f"  ! {label}: anchor NOT found ({'REQUIRED' if required else 'optional'}) — skipped")
        return
    if c > 1:
        print(f"  ! {label}: anchor found {c}× (ambiguous) — skipped"); return
    open(path, "w", encoding="utf-8").write(s.replace(old, new, 1))
    print(f"  + {label}")

print("Portava audit close-out — applying verified fixes\n")

# ── API-05: by-user must not select("*") — use the curated public column set ──
edit("src/routes/rentABuddy.ts",
'''  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();''',
'''  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .select(BUDDY_PUBLIC_COLUMNS)  // API-05: was select("*") — restrict to public columns like the sibling routes
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();''',
"API-05 by-user public columns")

# ── API-07: reject non-positive / non-numeric package price ───────────────────
edit("src/routes/rentABuddyMarketplace.ts",
'''  if (!title || !category || !priceUsd) return sendError(res, 'invalid_payload', "title, category, priceUsd required.");''',
'''  if (!title || !category || !priceUsd) return sendError(res, 'invalid_payload', "title, category, priceUsd required.");
  { const p = Number(priceUsd); if (!Number.isFinite(p) || p <= 0 || p > 100000) return sendError(res, 'invalid_payload', "priceUsd must be a positive number up to 100000."); }  // API-07''',
"API-07 package price guard")

# ── FL-04: remove the dead memoriesEnabled() helper (never called; fail-open) ─
edit("src/routes/memories.ts",
'''async function memoriesEnabled(sc: any): Promise<boolean> {
  try {
    const ok = await isFlagEnabled(sc, "memories_enabled");
    return ok;
  } catch {
    return true;
  }
}''',
'''// FL-04: removed the dead memoriesEnabled() helper — it was never called and
// failed OPEN, contradicting the fail-closed isFlagEnabled contract. The Memories
// routes are intentionally ungated (backend is live).''',
"FL-04 remove dead memories helper")

# ── delayedPostPublisher: honor an explicitly-passed null client (latent bug + test) ──
edit("src/lib/delayedPostPublisher.ts",
"  const db = opts?.client ?? resolveClient();",
'  const db = (opts && "client" in opts) ? opts.client : resolveClient();  // honor explicit null (was: ?? swallowed it)',
"delayedPostPublisher explicit-null client")

# ── Test fix: mount the marketplace router under /api (API-01 miss) ───────────
edit("src/test/rentBuddyReliabilityRoutes.test.ts",
"  app.use(marketplaceRouter);",
'  app.use("/api", marketplaceRouter);',
"test: marketplace router mount")

# ── Test fix: events media test must post an app-storage URL (stale test) ─────
edit("src/test/events-extension.test.ts",
'''    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/media`, {
      mediaUrl: "https://example.com/photo.jpg",
      mediaType: "image",
      caption: "Great time!",
    }, ID.user1);
    assert.equal(status, 201);
    assert.equal(body.media_url, "https://example.com/photo.jpg");''',
'''    const appUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/post-media/events/photo.jpg`;
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/media`, {
      mediaUrl: appUrl,
      mediaType: "image",
      caption: "Great time!",
    }, ID.user1);
    assert.equal(status, 201);
    assert.equal(body.media_url, appUrl);''',
"test: events media valid app URL")

# ── PROV-06: remove dead server map config from .env.example ──────────────────
for line in ["MAPTILER_API_KEY=<key>\n", "GOOGLE_MAPS_API_KEY=<key>\n"]:
    s = open(".env.example").read()
    if line in s:
        open(".env.example","w").write(s.replace(line,"")); print(f"  + PROV-06 removed {line.strip()}")
    else:
        print(f"  = PROV-06 {line.strip()}: already absent")

# ── PROV-04: document the used-but-undocumented env vars ──────────────────────
PROV04 = """
# ── Added by audit close-out (PROV-04): external creds/config read by the code ──
# OpenAI (stamp image generation / Compass intelligence)
AI_INTEGRATIONS_OPENAI_API_KEY=
AI_INTEGRATIONS_OPENAI_BASE_URL=
# Ticketmaster events ingest
TICKETMASTER_API_KEY=
# Mapbox geocoding token (server)
MAPBOX_TOKEN=
# Redis (rate limiting / cache) — optional
REDIS_URL=
# Internal secrets
COMPASS_TOKEN_SECRET=
INTERNAL_API_SECRET=
CLEANUP_ADMIN_SECRET=
# Supabase management tokens (CI/scripts)
SUPABASE_ACCESS_TOKEN=
SUPABASE_PROJECT_TOKEN=
# Calling (LiveKit) — see PROVISIONING.md PROV-03
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
# Identity/KYC — see PROVISIONING.md PROV-02
IDENTITY_PROVIDER=mock
"""
s = open(".env.example").read()
if "Added by audit close-out (PROV-04)" not in s:
    open(".env.example","a").write(PROV04); print("  + PROV-04 documented missing env vars")
else:
    print("  = PROV-04: already documented")

# ── package.json: set Supabase env for the `test` script (clears 47 failures) ─
# Surgical regex edit (no whole-file reformat).
s = open("package.json").read()
if '"test": "SUPABASE_URL=' in s:
    print("  = package.json: test env already set")
else:
    s2 = re.sub(r'("test":\s*")(node --import tsx/esm --test)',
                r'\1SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \2', s, count=1)
    if s2 != s:
        open("package.json","w").write(s2); print("  + package.json: test script env prefix")
    else:
        print("  ! package.json: test-script anchor not found — add the env prefix manually")

print("\nDone. Run: npx tsc -p tsconfig.json --noEmit  &&  node --import tsx/esm src/scripts/checkAsyncHandlers.ts")
