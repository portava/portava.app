/**
 * census-discovery §94 (lane W11-X2), C19 / W11A-B2 — the server-side
 * retirement of the `@username` byline on GET /discovery/community.
 *
 * `submittedBy.name` baked the literal `@username` into the name field for a
 * submitter who had not opted in: a redaction SHAPE no other surface uses
 * (`.agents/memory/display-name-privacy.md`: a null name plus a separate
 * handle). The client half is done (§60.5): no client surface reads `name`,
 * and the byline is resolved from `displayName` + `handle`
 * (features/discovery/communityByline.ts). What was left is the server's shape,
 * and changing it for today's shipping builds, which render `name` raw, is a
 * rollout decision (§60.8 Q2). So the canonical shape is built behind
 * `discovery_community_byline_canonical_enabled` (3490, seeded FALSE):
 *
 *   ON:  `name` is the real name iff `nameAllowed` (self, or opted in), else
 *        null — the same value as `displayName`. Never a handle.
 *   OFF / absent / unreadable: byte-identical to before (golden G0).
 *
 *   G0  flag ABSENT: the served body equals the golden captured at 3cc027a06
 *   G1  flag present and FALSE: the same golden
 *   B1  ON: an opted-out submitter's name is null; the handle still travels
 *   B2  ON: the viewer's own pick carries their real name (self-exemption)
 *   B3  ON: an opted-in submitter's real name is served
 *   B4  ON: no served `name` starts with "@", for any viewer
 *   B5  CONTROL, OFF: the legacy "@handle" is still served (pins what G0 hashes)
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryCommunityBylineCanonical.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import pino from "pino";
import discoveryRouter from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { newWorld, worldClient, flag, communityRow, profileRow, type WorldState } from "./helpers/fakeDiscoveryWorld.js";

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const FLAG = "discovery_community_byline_canonical_enabled";
const VIEWER = "c1900000-0000-4000-8000-000000000001";  // submits one pick, has NOT opted in
const HIDDEN = "c1900000-0000-4000-8000-0000000000a1";  // has not opted in
const OPTED  = "c1900000-0000-4000-8000-0000000000b2";  // opted in (show_real_name)
const NOHANDLE = "c1900000-0000-4000-8000-0000000000c3"; // no username at all
const TOKEN = "tok-c19-viewer";

function world(flags: Array<ReturnType<typeof flag>>): WorldState {
  return newWorld({
    users: { [TOKEN]: VIEWER },
    tables: {
      feature_flags: flags,
      discovery_places: [
        communityRow("p-own", { submitted_by: VIEWER }),
        communityRow("p-hidden", { submitted_by: HIDDEN }),
        communityRow("p-opted", { submitted_by: OPTED }),
        communityRow("p-nohandle", { submitted_by: NOHANDLE }),
      ],
      profiles: [
        profileRow(VIEWER, { name: "Vera Viewer", username: "vera" }),
        profileRow(HIDDEN, { name: "Hana Hidden", username: "hana" }),
        profileRow(OPTED, { name: "Otto Opted", username: "otto" }),
        profileRow(NOHANDLE, { name: "Nell Nohandle", username: null }),
      ],
      profile_privacy_settings: [{ user_id: OPTED, show_real_name: true }],
      user_follows: [], blocks: [], user_mutes: [], identity_verifications: [], rank_events: [],
    },
  });
}

function use(w: WorldState): void {
  const c = worldClient(w);
  _setTestServiceClient(c as any);
  _setTestClient(c as any, true);
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  globalThis.fetch = _originalFetch;
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { invalidateServeLogFlagCache(); });

async function community(token: string | null): Promise<any> {
  const res = await fetch(`${base}/discovery/community?city=Miami&limit=50`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * The served body with its per-serve clock removed: every `recommendationId`
 * is minted from the serve's own instant, so two identical serves differ only
 * there. Everything else — order, every field, every byline — is hashed.
 */
function normalized(body: any): string {
  return JSON.stringify(body, (k, v) => (k === "recommendationId" || k === "recommendation_id" || k === "servedAt" ? "<clock>" : v));
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Captured at 3cc027a06 (routes/discovery.ts before §94), flag absent, both viewers. */
const GOLDEN = {
  signedIn: "68582ef3dfabb9efb6b4afe4fa83ed43302f1aec68ae4da43b77fedd98e09339",
  anonymous: "dfb7cedae850d309cb0841705cbfc87456d464bd822dafa3d8613586489d6c08",
};

const byId = (body: any) => new Map<string, any>((body.items as any[]).map((it) => [it.submittedBy?.id, it.submittedBy]));

describe("C19 — the community byline's canonical shape, behind a FALSE flag", () => {
  it("G0 flag ABSENT: the served body is the golden captured before §94, for a signed-in and an anonymous viewer", async () => {
    use(world([]));
    const signedIn = normalized(await community(TOKEN));
    const anonymous = normalized(await community(null));
    if (process.env.W11X2_PRINT_GOLDEN) console.log(JSON.stringify({ signedIn: sha(signedIn), anonymous: sha(anonymous), body: JSON.parse(signedIn) }, null, 1));
    assert.equal(sha(signedIn), GOLDEN.signedIn);
    assert.equal(sha(anonymous), GOLDEN.anonymous);
  });

  it("G1 flag present and FALSE: the same golden", async () => {
    use(world([flag(FLAG, false)]));
    assert.equal(sha(normalized(await community(TOKEN))), GOLDEN.signedIn);
    assert.equal(sha(normalized(await community(null))), GOLDEN.anonymous);
  });

  it("B1 ON: an opted-out submitter's name is null, and the handle still travels", async () => {
    use(world([flag(FLAG, true)]));
    const by = byId(await community(TOKEN));
    assert.deepEqual({ name: by.get(HIDDEN).name, displayName: by.get(HIDDEN).displayName, handle: by.get(HIDDEN).handle }, { name: null, displayName: null, handle: "hana" });
    assert.equal(by.get(NOHANDLE).name, null, "no handle and no permission: null, not 'Traveler'");
  });

  it("B2 ON: the viewer's own pick carries their real name (self-exemption first)", async () => {
    use(world([flag(FLAG, true)]));
    assert.equal(byId(await community(TOKEN)).get(VIEWER).name, "Vera Viewer");
  });

  it("B3 ON: an opted-in submitter's real name is served, to anyone", async () => {
    use(world([flag(FLAG, true)]));
    assert.equal(byId(await community(null)).get(OPTED).name, "Otto Opted");
    assert.equal(byId(await community(TOKEN)).get(OPTED).name, "Otto Opted");
  });

  it("B4 ON: no served name starts with '@', and name always equals displayName, for every viewer", async () => {
    use(world([flag(FLAG, true)]));
    for (const token of [TOKEN, null]) {
      for (const it of (await community(token)).items as any[]) {
        assert.ok(!(typeof it.submittedBy?.name === "string" && it.submittedBy.name.startsWith("@")), `${it.id}: served name ${JSON.stringify(it.submittedBy?.name)}`);
        assert.equal(it.submittedBy?.name, it.submittedBy?.displayName, `${it.id}: the canonical name is the display name`);
      }
    }
  });

  it("B5 CONTROL, OFF: the legacy '@handle' is still what ships (what G0 hashes)", async () => {
    use(world([]));
    const by = byId(await community(null));
    assert.equal(by.get(HIDDEN).name, "@hana");
    assert.equal(by.get(NOHANDLE).name, "Traveler");
    assert.equal(by.get(OPTED).name, "Otto Opted");
  });
});
