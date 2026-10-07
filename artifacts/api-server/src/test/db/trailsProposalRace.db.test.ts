/**
 * trailsProposalRace.db.test.ts — census-discovery DC-03 (§61): `02_Trails.md`
 * §5's four canonicalization checks decide Trail creation under CONCURRENT
 * proposers, on the real schema (2910 + 3415), through the real service code.
 *
 *   P1  N racing near-duplicates with different slugs: exactly ONE is admitted
 *   P2  control: N racing proposals that do not collide are ALL admitted
 *   P3  the lock itself: a second proposal WAITS for the first to commit, then
 *       is refused by what it committed
 *   P4  a transaction snapshot is refused, not trusted; client roles cannot call
 *   P5  racing sub-Trails under one declared parent: the waiver does not let
 *       both in
 *   P6  a parent archived between the pre-check and the decision is refused
 *   P7  3415 absent: creation FAILS CLOSED (503), nothing is written
 *   P8  3975's proposer allowance under the same race: six racing proposals by
 *       ONE person that do not collide — exactly three are admitted and three
 *       answer rate_limited (the service's pre-check read 0 for every one of
 *       them, so the refusal is the per-proposer lock's); a second person is
 *       still admitted; called directly, trail_propose answers rate_limited
 *       and writes nothing
 *   G1  golden — slug: the SQL canonical slug equals canonicalTrailSlug
 *   G2  golden — similarity: the SQL jaccard equals titleSimilarity, rounding
 *       included
 *   G3  golden — the four checks: the SQL verdict equals
 *       canonicaliseTrailProposal on the same peers, exactly
 *   G4  golden — the non-racing path: a seeded sequence of proposals through the
 *       service gets the TypeScript verdict every time, and the SQL comparison
 *       set IS the set the service's pre-check read
 *
 * The races are PRODUCED, not hoped for: the bridge runs each statement in its
 * own async psql child and holds every proposal's WRITE until all N have
 * arrived, so every pre-check read has finished before any decision is taken —
 * the interleaving in which the old read-then-insert admitted all N. Each
 * decision's transaction then stays open HOLD_COMMIT_MS before it commits, so
 * the N decisions overlap in the database too: without 3415's lock every one
 * of them would decide on a snapshot holding none of the others' rows.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { HAVE_DB, LOCAL_DB_URL, exec, scalar, psql, jsonLiteral, seedUser } from "./localDb.js";
import { makeTrailBridge } from "./trailPostgrestBridge.js";
import { proposeTrail } from "../../services/trails/TrailService.js";
import { trailDestinationKey } from "../../lib/discoveryTrailFold.js";
import {
  canonicaliseTrailProposal, canonicalTrailSlug, titleSimilarity,
  type ExistingTrail, type TrailCreationRefusal,
} from "../../lib/discoveryTrailObject.js";

const RUN = randomUUID().replace(/-/g, "").slice(0, 8);
/** A title token unique to this run and case, so no other suite's Trail is ever a peer. */
const tag = (label: string) => `r${RUN}${label}`;
const users: string[] = [];
const tags: string[] = [];

function user(label: string): string {
  const id = seedUser(`p14${label}`);
  users.push(id);
  return id;
}

function newTag(label: string): string {
  const t = tag(label);
  tags.push(t);
  return t;
}

/** "the write of a proposal", in whatever form the service issues it: the 3415 call, or a direct insert. */
/** How long each racing decision's transaction stays open before it commits. */
const HOLD_COMMIT_MS = 400;
const isProposalWrite = (method: string, path: string) =>
  method === "POST" && (path.startsWith("/rest/v1/rpc/trail_propose") || /^\/rest\/v1\/trails(\?|$)/.test(path));
/** proposeTrail's comparison-set read (`select=id, slug, title, destination` with the peer `or=`). */
const isPeerRead = (e: { method: string; path: string }) =>
  e.method === "GET" && decodeURIComponent(e.path).startsWith("/rest/v1/trails?select=id,slug,title,destination");

/** One psql session run asynchronously, as `service_role`, in one transaction. */
function psqlAsync(sql: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("psql", ["-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => { out += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { err += c; });
    child.on("close", (status) => resolve({ status, stdout: out, stderr: err }));
    child.stdin.end(`SET LOCAL ROLE service_role;\n${sql}\n`);
  });
}

const lit = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

before(() => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT to_regprocedure('public.trail_propose(text,text,text,uuid,uuid)') IS NOT NULL;"), "t", "3415 must be applied");
});

after(() => {
  if (!HAVE_DB) return;
  for (const t of tags) exec(`DELETE FROM public.trails WHERE slug LIKE '%${t}%' OR destination LIKE '%${t}%';`);
  for (const id of users) exec(`DELETE FROM public.profiles WHERE id = '${id}';\nDELETE FROM auth.users WHERE id = '${id}';`);
});

describe("P — DC-03: the decision is serialised", { skip: !HAVE_DB }, () => {
  test("P1. six racing near-duplicates with six DIFFERENT slugs: exactly one is admitted and every other names it", async () => {
    const u = user("p1");
    const t = newTag("p1");
    const proposals: Array<[string, string | null]> = [
      [`${t} Bangkok After Dark`, `${t}-bangkok`],
      [`After Dark ${t} Bangkok`, `${t}-phuket`],
      [`Bangkok ${t} After-Dark`, null],
      [`Dark After Bangkok ${t}`, `${t}-bangkok`],
      [`${t} After Dark, Bangkok!`, `${t}-chiang-mai`],
      [`bangkok after dark ${t}`, `${t}-bangkok`],
    ];
    assert.equal(new Set(proposals.map(([title]) => canonicalTrailSlug(title))).size, proposals.length,
      "the slugs must all differ, or the UNIQUE index alone would be doing the refusing");

    const bridge = makeTrailBridge({ concurrent: true, barrier: { match: isProposalWrite, count: proposals.length }, holdCommitMs: HOLD_COMMIT_MS });
    const results = await Promise.all(proposals.map(([title, destination]) => proposeTrail(bridge.client, { title, destination }, u)));

    // The race was real: every pre-check read finished before the first decision ran.
    const firstWrite = bridge.log.findIndex((e) => isProposalWrite(e.method, e.path));
    const peerReads = bridge.log.map((e, i) => (isPeerRead(e) ? i : -1)).filter((i) => i >= 0);
    assert.equal(peerReads.length, proposals.length);
    assert.ok(firstWrite > Math.max(...peerReads), "a pre-check read ran after a decision — the race was not produced");

    const created = results.filter((r) => r.trail);
    assert.equal(created.length, 1, `admitted ${created.length}: ${JSON.stringify(results.map((r) => r.trail?.slug ?? r.canonicalisation.map((c) => c.check)))}`);
    const winner = created[0]!.trail!.id;
    for (const r of results.filter((x) => !x.trail)) {
      assert.equal(r.refusal, null, "a refused racer is a 409 canonicalisation refusal, not an error");
      assert.ok(r.canonicalisation.some((c) => c.check === "duplicate_title_similarity" && c.conflictsWith === winner),
        JSON.stringify(r.canonicalisation));
    }
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE slug LIKE '%${t}%';`), "1");
  });

  test("P2. control: six racing proposals that do not collide are all admitted (shared tokens serialise, they do not refuse)", async () => {
    // Six DIFFERENT proposers: 3975 allows one person three Trails a day, so six by one person would be
    // refused by the allowance, not admitted by the canonicalisation this control is about (P8 is that case).
    const proposers = Array.from({ length: 6 }, (_, i) => user(`p2${i}`));
    const t = newTag("p2");
    const proposals: Array<[string, string | null]> = [
      [`${t} Kyoto Hidden Temples`, `${t}-kyoto`],
      [`${t} Da Nang Coffee Crawl`, `${t}-da-nang`],
      [`${t} Seminyak Beach Clubs`, `${t}-bali`],
      [`${t} Tokyo First Timer`, `${t}-tokyo`],
      [`${t} Bangkok Rooftops`, `${t}-bangkok`],
      [`${t} Bangkok Temples`, `${t}-bangkok`],
    ];
    // The TypeScript checks agree none of them collides with any other.
    proposals.forEach(([title, destination], i) => {
      const others: ExistingTrail[] = proposals.filter((_, j) => j !== i)
        .map(([tt, d], j) => ({ id: `o${j}`, slug: canonicalTrailSlug(tt)!, title: tt, destination: d }));
      assert.equal(canonicaliseTrailProposal({ title, destination }, others).ok, true, title);
    });

    const bridge = makeTrailBridge({ concurrent: true, barrier: { match: isProposalWrite, count: proposals.length }, holdCommitMs: HOLD_COMMIT_MS });
    const results = await Promise.all(proposals.map(([title, destination], i) => proposeTrail(bridge.client, { title, destination }, proposers[i]!)));
    assert.deepEqual(results.map((r) => [r.refusal, r.trail?.slug ?? null]),
      proposals.map(([title]) => [null, canonicalTrailSlug(title)]));
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE slug LIKE '%${t}%';`), String(proposals.length));
  });

  test("P8. 3975: six racing, non-colliding proposals by ONE person — three admitted, three rate_limited by the per-proposer lock, nothing else written", async () => {
    const u = user("p8");
    const t = newTag("p8");
    const proposals: Array<[string, string | null]> = [
      [`${t} Kyoto Hidden Temples`, `${t}-kyoto`],
      [`${t} Da Nang Coffee Crawl`, `${t}-da-nang`],
      [`${t} Seminyak Beach Clubs`, `${t}-bali`],
      [`${t} Tokyo First Timer`, `${t}-tokyo`],
      [`${t} Bangkok Rooftops`, `${t}-bangkok`],
      [`${t} Bangkok Temples`, `${t}-bangkok`],
    ];
    const second: [string, string] = [`${t} Hoi An Lanterns`, `${t}-hoi-an`];
    // As in P2, the TypeScript checks agree nothing here collides, so every refusal below is the allowance's.
    [...proposals, second].forEach(([title, destination], i, all) => {
      const others: ExistingTrail[] = all.filter((_, j) => j !== i)
        .map(([tt, d], j) => ({ id: `o${j}`, slug: canonicalTrailSlug(tt)!, title: tt, destination: d }));
      assert.equal(canonicaliseTrailProposal({ title, destination }, others).ok, true, title);
    });
    const bridge = makeTrailBridge({ concurrent: true, barrier: { match: isProposalWrite, count: proposals.length }, holdCommitMs: HOLD_COMMIT_MS });
    const results = await Promise.all(proposals.map(([title, destination]) => proposeTrail(bridge.client, { title, destination }, u)));
    // The race was real: every proposal passed the service's own allowance read (0 started) and reached the write.
    assert.equal(bridge.log.filter((e) => isProposalWrite(e.method, e.path)).length, proposals.length, "every racer reached trail_propose");
    const admitted = results.filter((r) => r.trail);
    const limited = results.filter((r) => r.refusal === "rate_limited");
    assert.equal(admitted.length, 3, JSON.stringify(results.map((r) => r.refusal ?? r.trail?.slug)));
    assert.equal(limited.length, 3, JSON.stringify(results.map((r) => r.refusal ?? r.trail?.slug)));
    for (const r of limited) assert.equal(r.trail, null);
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE created_by = '${u}';`), "3");
    // Someone else is not limited by this person's allowance.
    const other = await proposeTrail(makeTrailBridge().client, { title: second[0], destination: second[1] }, user("p8b"));
    assert.equal(other.refusal, null, JSON.stringify(other));
    assert.ok(other.trail, "a second proposer is admitted");
    // The database decides it on its own (not only the service's pre-check): a direct call answers rate_limited, writes nothing.
    const direct = JSON.parse(exec(`SET LOCAL ROLE service_role;\nSELECT public.trail_propose(${lit(`${t} Hanoi Old Quarter`)}, ${lit(`${t}-hanoi`)}, NULL, NULL, '${u}')::text;`, { single: true }).at(-1)!);
    assert.equal(direct.outcome, "rate_limited", JSON.stringify(direct));
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE created_by = '${u}';`), "3");
  });

  test("P3. the lock: a second proposal waits for the first to COMMIT, then is refused by what it committed", async () => {
    const t = newTag("p3");
    const first = psqlAsync(
      `SELECT public.trail_propose(${lit(`${t} Night Market Walks`)}, ${lit(`${t}-a`)}, NULL, NULL, NULL)::text;\nSELECT pg_sleep(2.0101);`);
    // Start the second only once the first HOLDS its locks (it is sleeping inside its transaction).
    for (let i = 0; i < 200; i++) {
      if (scalar(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(2.0101)%' AND state = 'active';`) === "1") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const started = Date.now();
    const second = await psqlAsync(
      `SELECT public.trail_propose(${lit(`Walks Night Market ${t}`)}, ${lit(`${t}-b`)}, NULL, NULL, NULL)::text;`);
    const waited = Date.now() - started;
    const a = await first;
    assert.equal(a.status, 0, a.stderr);
    assert.equal(second.status, 0, second.stderr);
    const createdA = JSON.parse(a.stdout.trim().split("\n")[0]!);
    const answerB = JSON.parse(second.stdout.trim());
    assert.equal(createdA.outcome, "created");
    assert.equal(answerB.outcome, "refused", JSON.stringify(answerB));
    assert.ok(answerB.refusals.some((r: any) => r.check === "duplicate_title_similarity" && r.conflictsWith === createdA.trail.id));
    assert.ok(waited >= 1000, `the second proposal did not wait for the first (${waited} ms)`);
  });

  test("P4. a transaction snapshot is refused rather than trusted, and no client role may call trail_propose", () => {
    const t = newTag("p4");
    for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
      const r = psql(`BEGIN ISOLATION LEVEL ${level};\nSET LOCAL ROLE service_role;\nSELECT public.trail_propose(${lit(`${t} Guarded Harbour Lights`)}, NULL, NULL, NULL, NULL);\nCOMMIT;`);
      assert.notEqual(r.status, 0, level);
      assert.match(r.stderr, /requires READ COMMITTED/, level);
    }
    for (const role of ["anon", "authenticated"]) {
      const r = psql(`BEGIN;\nSET LOCAL ROLE ${role};\nSELECT public.trail_propose(${lit(`${t} Guarded Harbour Lights`)}, NULL, NULL, NULL, NULL);\nCOMMIT;`);
      assert.notEqual(r.status, 0, role);
      assert.match(r.stderr, /permission denied for function trail_propose/, role);
    }
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE slug LIKE '%${t}%';`), "0");
  });

  test("P5. two racing sub-Trails under ONE declared parent: the parent's waiver does not admit both", async () => {
    const u = user("p5");
    const t = newTag("p5");
    const parent = await proposeTrail(makeTrailBridge().client, { title: `${t} Riverside Evenings`, destination: `${t}-bangkok` }, u);
    assert.ok(parent.trail, JSON.stringify(parent));
    const kids: Array<[string, string]> = [
      [`${t} Riverside Evenings Thonglor`, `${t}-bangkok`],
      [`Thonglor ${t} Riverside Evenings`, `${t}-bangkok`],
    ];
    const bridge = makeTrailBridge({ concurrent: true, barrier: { match: isProposalWrite, count: kids.length }, holdCommitMs: HOLD_COMMIT_MS });
    const results = await Promise.all(kids.map(([title, destination]) =>
      proposeTrail(bridge.client, { title, destination, parentTrailId: parent.trail!.id }, u)));
    const created = results.filter((r) => r.trail);
    assert.equal(created.length, 1, JSON.stringify(results));
    assert.equal(created[0]!.trail!.parent_trail_id, parent.trail!.id);
    const refused = results.find((r) => !r.trail)!;
    assert.ok(refused.canonicalisation.some((c) => c.check === "duplicate_title_similarity" && c.conflictsWith === created[0]!.trail!.id));
    assert.ok(!refused.canonicalisation.some((c) => c.conflictsWith === parent.trail!.id && c.check !== "duplicate_title_similarity"),
      "the parent's own overlap refusals are still waived");
  });

  test("P6. a parent archived between the pre-check and the decision is refused, and nothing is created", async () => {
    const u = user("p6");
    const t = newTag("p6");
    const base = makeTrailBridge();
    const parent = await proposeTrail(base.client, { title: `${t} Canal Evenings`, destination: `${t}-x` }, u);
    assert.ok(parent.trail);
    // The pre-check reads the parent while it is live; the archive lands just before the decision.
    const racing: any = Object.create(base.client);
    racing.rpc = (fn: string, args: unknown) => {
      exec(`UPDATE public.trails SET lifecycle_status = 'archived' WHERE id = '${parent.trail!.id}';`);
      return base.client.rpc(fn, args);
    };
    const r = await proposeTrail(racing, { title: `${t} Klong Toei Lanes`, destination: `${t}-y`, parentTrailId: parent.trail!.id }, u);
    assert.equal(r.refusal, "invalid_request");
    assert.equal(r.trail, null);
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE parent_trail_id = '${parent.trail!.id}';`), "0");
  });

  test("P7. without 3415 creation FAILS CLOSED: `trails_unavailable` (503), and no Trail is written unserialised", async () => {
    const u = user("p7");
    const t = newTag("p7");
    const bridge = makeTrailBridge({ failTables: { "rpc/trail_propose": { code: "PGRST202", message: "Could not find the function public.trail_propose(p_created_by, p_description, p_destination, p_parent_trail_id, p_title) in the schema cache" } } });
    const r = await proposeTrail(bridge.client, { title: `${t} Lantern Alleys`, destination: `${t}-hoi-an` }, u);
    assert.equal(r.refusal, "trails_unavailable");
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE slug LIKE '%${t}%';`), "0");
    assert.ok(!bridge.log.some((e) => e.method === "POST" && e.path.startsWith("/rest/v1/trails")), "fell back to a direct insert");
  });
});

// ── Golden: same inputs, same verdicts ──────────────────────────────────────

/** mulberry32 — a seeded PRNG, so a failing corpus is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "bangkok", "after", "dark", "rooftops", "temples", "kyoto", "hidden", "coffee", "crawl", "night", "market",
  "Café", "CAFÉ", "cafe", "Straße", "İstanbul", "ﬁre", "Kyoto’s", "Ｔｏｋｙｏ", "①",
  "x²", "\u{1F319}", "naïve", "Ångström", "São", "Paulo", "Ⅻ", "live-music", "late_night", "Da", "Nang",
  "Đà", "Nẵng", "Kelvin", "BANGKOK", "Dark", "AFTER",
  // §61 (DV-20): every stroke letter lib/canonicalLocations folds.
  "\u0141\u00f3d\u017a", "\u00d8restad", "\u0126amrun", "\u0166ana", "\u00d0j\u00fapi", "\u0131stanbul", "\u0111\u01b0\u1eddng",
  "Stra\u00dfe", "GRO\u1e9eE", "\u00c6sir", "C\u0153ur", "\u00deing", "\u014aoma",
];
const SEPARATORS = [" ", "  ", "-", ", ", "!", " — ", "\t", " ", "/"];
const DESTINATIONS: Array<string | null> = [
  "Bangkok", " bangkok ", "BANGKOK", "Kyoto", "new york", "New  York", "new york", "São Paulo", "", null,
  "Đà Nẵng", "bangkok\t", "phuket",
  // §61 (DV-20): spellings of one place, and searchKey's generic prefix / suffix.
  "da nang", "DA  NANG", "City of Manila", "manila", "Cebu City", "\u0141\u00f3d\u017a", "lodz", "Stra\u00dfe", "strasse",
];

function title(rand: () => number, words = WORDS): string {
  const n = 1 + Math.floor(rand() * 5);
  let s = "";
  for (let i = 0; i < n; i++) {
    if (i > 0) s += SEPARATORS[Math.floor(rand() * SEPARATORS.length)];
    s += words[Math.floor(rand() * words.length)];
  }
  return rand() < 0.1 ? `  ${s}  ` : s;
}

/** As proposeTrail stores and passes a destination: trimmed and lowercased in JavaScript. */
const stored = (d: string | null) => (typeof d === "string" ? d.trim().toLowerCase() : null);

const sqlVerdicts = (cases: Array<{ title: string; destination: string | null; peers: ExistingTrail[] }>) =>
  JSON.parse(exec(`SELECT json_agg(public.trail_canonicalisation_verdict(c->>'title', c->>'destination', c->'peers') ORDER BY ord)::text
                     FROM jsonb_array_elements(${jsonLiteral(cases)}) WITH ORDINALITY AS x(c, ord);`).join("\n")) as any[];

describe("G — golden: the SQL checks are the TypeScript checks", { skip: !HAVE_DB }, () => {
  test("G1. the canonical slug, on hostile and non-ASCII titles, is canonicalTrailSlug's", () => {
    const rand = prng(3415);
    const inputs = [
      "Bangkok After Dark", "  Café — Kyoto’s  NIGHTS!! ", "ﬁre & ice", "①② x²", "Ⅻ nights",
      "Kelvin Å", "İstanbul", "Straße", "São Paulo", "\u{1F319}\u{1F319}", "", "---", "a--b", "Đà Nẵng",
      "Ｔｏｋｙｏ First-Timer", "ǅemal", "Ωmega ωmega", "日本 東京", "naïvé café", "tab\there",
      ...Array.from({ length: 300 }, () => title(rand)),
    ];
    const sql = JSON.parse(exec(`SELECT json_agg(public.trail_canonical_slug(v ->> 0) ORDER BY ord)::text
                                   FROM jsonb_array_elements(${jsonLiteral(inputs.map((s) => [s]))}) WITH ORDINALITY AS x(v, ord);`).join("\n"));
    assert.deepEqual(sql, inputs.map((s) => canonicalTrailSlug(s)));
  });

  test("G2. similarity, rounding included, is titleSimilarity's for every (|A|, |B|, shared) up to 14", () => {
    const pairs: Array<[string, string]> = [];
    for (let na = 1; na <= 14; na++) for (let nb = 1; nb <= 14; nb++) for (let s = 0; s <= Math.min(na, nb); s++) {
      const shared = Array.from({ length: s }, (_, i) => `s${i}`);
      pairs.push([[...shared, ...Array.from({ length: na - s }, (_, i) => `a${i}`)].join(" "),
        [...shared, ...Array.from({ length: nb - s }, (_, i) => `b${i}`)].join(" ")]);
    }
    const sql = JSON.parse(exec(`SELECT json_agg(public.trail_token_similarity(public.trail_title_tokens(v ->> 0), public.trail_title_tokens(v ->> 1)) ORDER BY ord)::text
                                   FROM jsonb_array_elements(${jsonLiteral(pairs)}) WITH ORDINALITY AS x(v, ord);`).join("\n"));
    assert.deepEqual(sql, pairs.map(([a, b]) => titleSimilarity(a, b)));
  });

  test("G3. the four checks over the same peers, in the same order, give the same verdict — 600 seeded cases", () => {
    const rand = prng(61);
    const cases: Array<{ title: string; destination: string | null; peers: ExistingTrail[] }> = [];
    for (let k = 0; k < 600; k++) {
      const mine = title(rand);
      const destination = stored(DESTINATIONS[Math.floor(rand() * DESTINATIONS.length)]!);
      const peers: ExistingTrail[] = Array.from({ length: Math.floor(rand() * 7) }, (_, i) => {
        // Peers are built to collide often: re-orderings, supersets and subsets of `mine`.
        const r = rand();
        const words = (canonicalTrailSlug(mine) ?? "x").split("-");
        const t = r < 0.25 ? [...words].reverse().join(" ")
          : r < 0.45 ? `${words.join(" ")} ${WORDS[Math.floor(rand() * WORDS.length)]}`
          : r < 0.6 ? words.slice(0, Math.max(1, words.length - 1)).join(" ")
          : title(rand);
        const slug = rand() < 0.1 ? (canonicalTrailSlug(mine) ?? `slug-${k}-${i}`) : (canonicalTrailSlug(t) ?? `slug-${k}-${i}`);
        return { id: `00000000-0000-4000-8000-${String(k * 10 + i).padStart(12, "0")}`, slug, title: t,
          destination: rand() < 0.6 ? destination : stored(DESTINATIONS[Math.floor(rand() * DESTINATIONS.length)]!) };
      });
      cases.push({ title: mine, destination, peers });
    }
    const sql = sqlVerdicts(cases);
    const ts = cases.map((c) => canonicaliseTrailProposal({ title: c.title, destination: c.destination }, c.peers));
    let refusing = 0;
    cases.forEach((c, i) => {
      assert.deepEqual(sql[i], ts[i], `case ${i}: ${JSON.stringify(c)}`);
      if (!ts[i]!.ok) refusing += 1;
    });
    // Not vacuous: most cases collide, and every check fires somewhere.
    assert.ok(refusing > 300, `only ${refusing} refusing cases`);
    for (const check of ["uncanonicalisable_title", "duplicate_title_similarity", "destination_overlap", "semantic_overlap", "existing_parent_child"]) {
      assert.ok(ts.some((v) => v.refusals.some((r) => r.check === check)), `${check} never fired`);
    }
  });

  test("G4. the non-racing path: 40 sequential proposals get the TypeScript verdict, over the set the pre-check read", async () => {
    // One proposer per case: 3975 allows one person three Trails a day, and this is the canonicalisation's
    // golden, not the allowance's (P8 is that).
    const t = newTag("g4");
    const rand = prng(1906);
    const theme = ["river", "night", "market", "temple", "rooftop", "coffee", "crawl", "walk", "Café", "Straße", "naïve", "live"];
    const places = [`${t}-bangkok`, `${t}-phuket`, null, ` ${t.toUpperCase()}-Bangkok `, `${t}-kyoto`];
    // A destination-less Trail that shares NO token with any proposal below: only
    // the `destination IS NULL` leg of the filter reads it, so a SQL comparison set
    // that dropped that leg would differ from the pre-check's here.
    const x = newTag("x4g"); // not "g4…": a tag containing this test's own token would match its ILIKE leg
    exec(`INSERT INTO public.trails (slug, title, destination, lifecycle_status) VALUES ('${x}-unrelated-harbour', '${x} Unrelated Harbour', NULL, 'active');`);
    const bridge = makeTrailBridge();
    const createdIds: string[] = [];
    let admitted = 0;
    let refused = 0;
    for (let k = 0; k < 40; k++) {
      const words = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => theme[Math.floor(rand() * theme.length)]!);
      const titleK = rand() < 0.5 ? `${t} ${words.join(" ")}` : `${words.join(" ")} ${t}`;
      const destination = places[Math.floor(rand() * places.length)]!;
      const parentTrailId = createdIds.length > 0 && rand() < 0.2 ? createdIds[Math.floor(rand() * createdIds.length)]! : null;
      const passed = stored(destination);

      // What the database will compare against, read BEFORE the proposal…
      const peers = JSON.parse(scalar(`SELECT public.trail_proposal_peers(${lit(titleK)}, ${lit(passed)})::text;`)!) as ExistingTrail[];
      const expected = canonicaliseTrailProposal({ title: titleK, destination: passed }, peers);
      const waived = expected.refusals.filter((r) => !(parentTrailId !== null && r.conflictsWith === parentTrailId
        && ["existing_parent_child", "destination_overlap", "semantic_overlap"].includes(r.check)));

      const from = bridge.log.length;
      const r = await proposeTrail(bridge.client, { title: titleK, destination, parentTrailId }, user(`g4${k}`));

      // …is exactly what the service's own pre-check read (re-run now, minus what this call created).
      const peerRead = bridge.log.slice(from).find(isPeerRead)!;
      const tsIds = new Set((JSON.parse(exec(peerRead.sql).join("\n")) as any[]).map((x) => x.id as string));
      if (r.trail) tsIds.delete(r.trail.id);
      assert.deepEqual([...tsIds].sort(), peers.map((p) => p.id).sort(), `case ${k}: the SQL comparison set is not the pre-check's`);

      const key = (x: TrailCreationRefusal) => `${x.check}|${x.conflictsWith}|${x.similarity}`;
      if (waived.length === 0) {
        assert.ok(r.trail, `case ${k}: TypeScript admits "${titleK}" but the service refused: ${JSON.stringify(r)}`);
        assert.equal(r.trail!.slug, expected.slug);
        createdIds.push(r.trail!.id);
        admitted += 1;
      } else {
        assert.equal(r.trail, null, `case ${k}: TypeScript refuses "${titleK}" but the service admitted it`);
        assert.deepEqual(r.canonicalisation.map(key).sort(), waived.map(key).sort(), `case ${k}`);
        refused += 1;
      }
    }
    assert.ok(admitted >= 5 && refused >= 10, `admitted ${admitted}, refused ${refused}: the sequence must exercise both`);
  });
});

// ── DV-20 (§61): one place, one identity, whatever the spelling ─────────────

describe("S — DV-20: stroke letters fold and one destination is one destination, in the service and in the database", { skip: !HAVE_DB }, () => {
  test("S5. the defect's own case, through the service: 'Da Nang street food' is refused beside 'Đà Nẵng street food'", async () => {
    const u = user("s5");
    const t = newTag("s5");
    const bridge = makeTrailBridge();
    const first = await proposeTrail(bridge.client, { title: `Đà Nẵng street food ${t}`, destination: `Đà Nẵng ${t}` }, u);
    assert.ok(first.trail, JSON.stringify(first));
    assert.equal(first.trail!.slug, `da-nang-street-food-${t}`);
    const second = await proposeTrail(bridge.client, { title: `Da Nang street food ${t}`, destination: `da nang ${t}` }, u);
    assert.equal(second.trail, null, "a second Trail for one theme was admitted under another spelling");
    assert.ok(second.canonicalisation.some((c) => c.check === "duplicate_title_similarity" && c.conflictsWith === first.trail!.id));
  });

  test("S6. the database compares destinations by key even when the pre-check could not read the peer", async () => {
    const u = user("s6");
    const t = newTag("s6");
    // A peer the pre-check CANNOT read: its destination is spelled differently (the
    // PostgREST `destination = x` leg misses it), it has one, and its slug holds
    // none of the proposal's pigeonhole tokens ("panoramas" is the longest).
    const peer = randomUUID();
    exec(`INSERT INTO public.trails (id, slug, title, destination, lifecycle_status)
          VALUES ('${peer}', 'rooftop-bars-${t}', 'Rooftop Bars', 'đà nẵng ${t}', 'active');`);
    const bridge = makeTrailBridge();
    const r = await proposeTrail(bridge.client, { title: "Rooftop Bars Panoramas", destination: `DA NANG ${t}` }, u);
    const preCheck = bridge.log.find(isPeerRead)!;
    const preCheckIds = (JSON.parse(exec(preCheck.sql).join("\n")) as any[]).map((x) => x.id);
    assert.ok(!preCheckIds.includes(peer), "the pre-check read the peer, so this case would not exercise the database's key leg");
    assert.equal(r.trail, null, "admitted beside the same place under another spelling");
    assert.deepEqual(r.canonicalisation.filter((c) => c.conflictsWith === peer).map((c) => c.check).sort(),
      ["destination_overlap", "existing_parent_child", "semantic_overlap"]);
    assert.equal(r.suggestedParentTrailId, peer);
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE slug = 'rooftop-bars-panoramas';`), "0");
  });

  test("S7. parity: the SQL destination key is trailDestinationKey (the letter fold, then B01's searchKey), on every spelling in the corpus", () => {
    const inputs = [...DESTINATIONS.filter((d): d is string => typeof d === "string"),
      "  Đà  Nẵng!! ", "city of", "Metro Manila", "Ho Chi Minh City", "Province of Cebu", "\u{1F319}", "---", " ", "KelvinK",
      ...WORDS.flatMap((w) => [w, `${w} city`, `city of ${w}`])];
    const sql = JSON.parse(exec(`SELECT json_agg(public.trail_normalised_destination(v ->> 0) ORDER BY ord)::text
                                   FROM jsonb_array_elements(${jsonLiteral(inputs.map((s) => [s]))}) WITH ORDINALITY AS x(v, ord);`).join("\n"));
    assert.deepEqual(sql, inputs.map((s) => trailDestinationKey(s) || null));
  });

  test("S8. parity over the whole letter enumeration (§73, DV-20): the SQL slug and destination key are the TypeScript's for every one of the 1453 Latin letters in Unicode 17", () => {
    const letters: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) { if (cp === 0xd800) cp = 0xe000; const ch = String.fromCodePoint(cp); if (/^(?=\p{Script=Latin})\p{L}$/u.test(ch)) letters.push(ch); }
    const inputs = letters.flatMap((ch) => [ch, `x${ch}x`, `${ch}resund cycling`]);
    const sql = JSON.parse(exec(`SELECT json_agg(json_build_array(public.trail_canonical_slug(v ->> 0), public.trail_normalised_destination(v ->> 0)) ORDER BY ord)::text
                                   FROM jsonb_array_elements(${jsonLiteral(inputs.map((s) => [s]))}) WITH ORDINALITY AS x(v, ord);`).join("\n")) as Array<[string | null, string | null]>;
    const diff = inputs.flatMap((s, i) => {
      const want: [string | null, string | null] = [canonicalTrailSlug(s), trailDestinationKey(s) || null];
      return sql[i]![0] === want[0] && sql[i]![1] === want[1] ? [] : [`${s}: sql ${JSON.stringify(sql[i])} ts ${JSON.stringify(want)}`];
    });
    assert.equal(letters.length, 1453, "every Latin letter in Unicode 17");
    // One divergence, outside the criterion and older than §73: U+A7F1 MODIFIER LETTER CAPITAL S (added in Unicode 17)
    // has the compatibility decomposition <super> S. Node's NFKD knows it; this PostgreSQL's does not, so the slug
    // keeps an 's' in TypeScript and deletes it in SQL. Every other Latin letter agrees.
    assert.deepEqual(diff.filter((d) => !d.includes("\ua7f1")), []);
    assert.equal(diff.length, 3, diff.join("\n"));
    assert.deepEqual(sql[inputs.indexOf("Ǿresund cycling")], ["oresund-cycling", "oresund cycling"], "the defect's own case, in SQL");
  });
});
