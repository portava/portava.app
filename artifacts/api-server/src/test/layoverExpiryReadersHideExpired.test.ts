/**
 * census-layover §84 — the PRECONDITION for gating the presence and crew expiry sweeps behind 3952's default-OFF flags:
 * every reader of `layover_presence` and `layover_crews` already hides a row whose `expires_at` has passed, the way
 * the checkpoint readers do (3950). If one did not, stopping the sweep would surface stale presence or a dead crew.
 *
 *   1. STATIC, PINNED. Every `.from("layover_presence")` / `.from("layover_crews")` read in src/ (outside tests, the two
 *      sweeps and erasure) carries `.gt("expires_at", …)` in its own chain, and the set of such read sites is pinned, so a
 *      new reader fails here until it is reviewed. `layover_crew_members` has no expiry of its own; every call of
 *      `crewMembers` / `liveMembersOfCrews` is pinned too, each taking its crew id from an expiry-filtered crew read.
 *   2. BEHAVIOURAL. With the sweeps OFF, an expired crew (with a live membership row) and an expired presence row stay in
 *      storage, and every reader answers as if they were gone; the same rows unexpired are seen (the control).
 *
 * The SQL readers are write-side guards: 3872's plan guard and 3996's grant guard both refuse a crew whose
 * `expires_at <= now()` (pinned below by text).
 *
 * Run: node --import tsx/esm --test src/test/layoverExpiryReadersHideExpired.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { activeCrewForUser, openCrewsInCity, joinCrew } from "../services/layover/LayoverCrewStore.js";
import { readOwnPresence, intentCounts } from "../services/layover/LayoverPresenceStore.js";

const SRC = new URL("..", import.meta.url).pathname;
const EXEMPT = new Set([
  "lib/layoverPresenceExpiryScheduler.ts", // the deleter (reads expired rows on purpose: `.lte`)
  "lib/layoverCrewExpiryScheduler.ts", // the deleter (`.lt`)
  "services/accountDeletion/AccountDeletionService.ts", // erasure deletes by user, whatever the expiry
]);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!["test", "__tests__", "migrations", "node_modules"].includes(e)) out.push(...files(p)); }
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Each `.from("<table>")` with the statement it starts (up to the terminating `;`). */
function sites(table: string): Array<{ file: string; line: number; chain: string }> {
  const out: Array<{ file: string; line: number; chain: string }> = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    if (EXEMPT.has(rel)) continue;
    const src = readFileSync(f, "utf8");
    const needle = `.from("${table}")`;
    for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
      const end = src.indexOf(";", i);
      out.push({ file: rel, line: src.slice(0, i).split("\n").length, chain: src.slice(i, end === -1 ? undefined : end) });
    }
  }
  return out;
}
const isRead = (chain: string) => /\.select\(/.test(chain) && !/\.(insert|update|upsert|delete)\(/.test(chain);

describe("§84 (1) every presence and crew READER filters on expires_at — pinned", () => {
  it("layover_presence: each read site carries .gt(\"expires_at\", …), and the set of read sites is exactly these", () => {
    const reads = sites("layover_presence").filter((s) => isRead(s.chain));
    for (const r of reads) assert.match(r.chain, /\.gt\("expires_at",/, `${r.file}:${r.line} reads layover_presence without hiding expired rows`);
    assert.deepEqual(reads.map((r) => r.file).sort(), ["services/layover/LayoverPresenceStore.ts", "services/layover/LayoverPresenceStore.ts"],
      "a new layover_presence reader: review it for the expires_at filter, then pin it here");
  });

  it("layover_crews: each read site carries .gt(\"expires_at\", …), and the set of read sites is exactly these", () => {
    const reads = sites("layover_crews").filter((s) => isRead(s.chain));
    for (const r of reads) assert.match(r.chain, /\.gt\("expires_at",/, `${r.file}:${r.line} reads layover_crews without hiding expired crews`);
    assert.deepEqual(reads.map((r) => r.file).sort(), ["services/layover/LayoverCrewStore.ts", "services/layover/LayoverCrewStore.ts", "services/layover/LayoverCrewStore.ts"],
      "a new layover_crews reader: review it for the expires_at filter, then pin it here");
  });

  it("layover_crew_members carries no expiry: every member read takes its crew id from an expiry-filtered crew read (pinned)", () => {
    const calls: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b(crewMembers|liveMembersOfCrews)\((\w+), ([^)]*)\)/g)) calls.push(`${rel} ${m[1]}(${m[3]})`);
    }
    assert.deepEqual(calls.sort(), [
      "routes/airport.ts crewMembers(mine.value.crew.id)", // activeCrewForUser
      "routes/airport.ts crewMembers(mine.value.crew.id)",
      "routes/layoverCrewLocation.ts crewMembers(crew.id)", // crewLocationBody: its crew is activeCrewForUser's (route at :211)
      "services/layover/LayoverCrewAbortNotice.ts crewMembers(mine.value.crew.id)",
      "services/layover/LayoverCrewAbortNotice.ts crewMembers(mine.value.crew.id)",
      "services/layover/LayoverCrewStore.ts crewMembers(crew.id)", // joinCrew: the crew read is .gt("expires_at")
      "services/layover/LayoverCrewStore.ts crewMembers(crew.id)",
      "services/layover/LayoverCrewVisibility.ts crewMembers(crew.id)", // compassCrewCandidates: activeCrewForUser
      "services/layover/LayoverCrewVisibility.ts liveMembersOfCrews(open.value.map((c)", // openCrewsInCity (the pattern stops at the first ")")
      "services/layover/LayoverPresenceStore.ts crewMembers(mine.value.crew.id)",
    ].sort(), "a new member read: show its crew id comes from an expiry-filtered read, then pin it here");
  });

  it("the SQL guards refuse an expired crew (3872's plan guard, 3996's location-grant guard)", () => {
    for (const f of ["3872_layover_crew_plans.sql", "3996_layover_crew_location_grants.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
      assert.match(sql, /IF NOT FOUND OR c_status = 'disbanded' OR c_expires <= now\(\) THEN/, f);
    }
  });
});

describe("§84 (2) with the sweeps OFF, expired rows stay in storage and every reader answers as if they were gone", () => {
  const NOW = Date.parse("2026-10-24T12:00:00.000Z");
  const iso = (m: number) => new Date(NOW + m * 60_000).toISOString();
  const crew = (id: string, expiresInMin: number) => ({
    id, city: "taoyuan", airport_ref: "TPE", created_by: "u-owner", created_session_id: "s-owner", title: "crew",
    meeting_point_label: null, status: "open", max_members: 6, expires_at: iso(expiresInMin), created_at: iso(-120), updated_at: iso(-120),
  });
  const member = (crewId: string, user: string) => ({ crew_id: crewId, user_id: user, session_id: `s-${user}`, role: "member", joined_at: iso(-60), left_at: null });
  const presence = (session: string, user: string, expiresInMin: number) => ({
    session_id: session, user_id: user, visibility_scope: "intent", intents: ["food"], available_from: iso(-120), available_until: iso(expiresInMin),
    max_travel_minutes: null, precise_location_enabled: false, expires_at: iso(expiresInMin), created_at: iso(-120), updated_at: iso(-120),
  });
  const t: Record<string, any[]> = {};
  const world = (expiresInMin: number) => {
    for (const k of Object.keys(t)) delete t[k];
    Object.assign(t, {
      feature_flags: [{ flag: "layover_presence_intents_enabled", enabled: true }, { flag: "layover_presence_expiry_enabled", enabled: false }, { flag: "layover_crew_expiry_enabled", enabled: false }],
      layover_crews: [crew("c-1", expiresInMin)],
      layover_crew_members: [member("c-1", "u-ana")],
      layover_presence: [presence("s-ana", "u-ana", expiresInMin)],
    });
    return makeLayoverDb(t) as any;
  };

  for (const [label, minutes, seen] of [["expired an hour ago", -60, false], ["CONTROL: live for an hour", 60, true]] as const) {
    it(`${label}: activeCrewForUser, openCrewsInCity, joinCrew, readOwnPresence and intentCounts`, async () => {
      const db = world(minutes);
      const now = new Date(NOW).toISOString();
      const mine = await activeCrewForUser(db, "u-ana", now);
      assert.equal(mine.ok, true);
      assert.equal(mine.ok && mine.value !== null, seen, "activeCrewForUser");
      const open = await openCrewsInCity(db, "taoyuan", now);
      assert.equal(open.ok && open.value.some((c) => c.id === "c-1"), seen, "openCrewsInCity");
      const join = await joinCrew(db, { userId: "u-bo", sessionId: "s-bo", crewId: "c-1", city: "taoyuan", admit: async () => "admit" }, now);
      if (!seen) assert.deepEqual(join, { ok: false, reason: "crew_unavailable" }, "joinCrew of an expired crew");
      const own = await readOwnPresence(db, "s-ana", NOW);
      assert.equal(own.ok && own.record !== null, seen, "readOwnPresence");
      const counts = await intentCounts(db, ["u-ana"], NOW);
      assert.equal(counts.ok && counts.counts.food === 1, seen, "intentCounts");
      // the rows themselves are still in storage: the sweeps are OFF
      assert.equal(t.layover_crews!.length, 1, "the crew row is still stored");
      assert.equal(t.layover_presence!.length, 1, "the presence row is still stored");
    });
  }
});
