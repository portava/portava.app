/**
 * check:scheduler-relative-windows — the guard over work selected by a window
 * measured from NOW.
 *
 * WHY THIS EXISTS. The guard's whole value is that it can FAIL on the shape it
 * names, so most of what follows is negative cases: a bare window, a forward
 * band, a window inside SQL text, a bound this tracer cannot read, an
 * allowlist entry whose inspection proof has gone. A guard that passes
 * everything and a correct guard look identical on a green tree
 * (CONTRIBUTING.md:33-66 — prove the check can fail), so each test below
 * states the drift it would catch.
 *
 * The last two blocks assert the STATE OF THE TREE rather than the behaviour
 * of a function: that the real scan is clean, and that mutating a site the
 * watermark fixed turns it back into a violation. The mutation is done on the
 * real file's text IN MEMORY — nothing on disk is touched — so this test can
 * never leave the tree modified.
 *
 * Run directly (it is not in package.json's curated `test` list yet):
 *   node --import tsx/esm --test src/test/schedulerRelativeWindows.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWLIST,
  DEFECT_LABELS,
  MIN_REASON_CHARS,
  PLAUSIBLE_GAP_MS,
  SRC_ROOT,
  applyAllowlist,
  isTemporalColumn,
  readTree,
  scanTree,
  setFileHolds,
  sitesIn,
  type AllowEntry,
  type Site,
  type Verdict,
} from "../scripts/checkSchedulerRelativeWindows.js";

/** The one site in a snippet, or a failure naming what was found instead. */
function only(code: string): Site {
  const sites = sitesIn("snippet.ts", code);
  assert.equal(sites.length, 1, `expected exactly one site, got ${sites.length}: ${sites.map((s) => s.key).join(", ")}`);
  return sites[0]!;
}

function verdictOf(code: string): Verdict {
  return only(code).verdict;
}

describe("what counts as a site", () => {
  /**
   * THE DEFECT ITSELF. If this stops reading `bare`, the guard has stopped
   * detecting the thing it exists for and every run is a false green.
   */
  it("a bare backward window is a violation", () => {
    const s = only(`
      const WINDOW_MS = 60 * 60 * 1000;
      async function pass(db: any) {
        const since = new Date(Date.now() - WINDOW_MS).toISOString();
        return db.from("events").select("id").gte("created_at", since);
      }
    `);
    assert.equal(s.verdict, "bare");
    assert.equal(s.widthMs, 3_600_000, "the width must be folded, or the site cannot be compared to the plausible gap");
    assert.equal(s.table, "events");
    assert.equal(s.key, 'snippet.ts::pass::events.gte("created_at")');
  });

  /**
   * The fix, in the shape TrustGamingDetectionService uses: a local helper
   * returns the span and one branch of that helper is the documented
   * unreadable-mark fallback. The watermark must win over that fallback, or
   * the correct refusal reads as the defect.
   */
  it("a window traced to scanWindow through a local helper PASSES, fallback branch and all", () => {
    assert.equal(
      verdictOf(`
        import { scanWindow, readWatermark } from "../lib/schedulerWatermark.js";
        async function windowFor(db: any, job: string) {
          const now = new Date();
          const mark = await readWatermark(db, job);
          if (!mark.ok) return { sinceIso: new Date(now.getTime() - 24 * 3600_000).toISOString() };
          const win = scanWindow({ watermark: mark.at, now, defaultLookbackMs: 1, maxCatchupMs: 2 });
          return { sinceIso: win.since.toISOString() };
        }
        async function detect(db: any) {
          const w = await windowFor(db, "j");
          return db.from("trust_events").select("user_id").gt("created_at", w.sinceIso);
        }
      `),
      "watermarked",
    );
  });

  /** The CompassAbuseDefenseEngine shape: the span is parked in a Map first. */
  it("a window traced to scanWindow through a Map whose every write is visible PASSES", () => {
    assert.equal(
      verdictOf(`
        import { scanWindow } from "../lib/schedulerWatermark.js";
        const windows = new Map<string, any>();
        function build(now: Date) {
          for (const key of ["a"]) {
            windows.set(key, scanWindow({ watermark: null, now, defaultLookbackMs: 1, maxCatchupMs: 2 }));
          }
        }
        async function detect(db: any) {
          const w = windows.get("a");
          return db.from("hashtag_usage").select("hashtag_id").gte("created_at", w.since.toISOString());
        }
      `),
      "watermarked",
    );
  });

  /**
   * The self-healing shapes. If either of these were flagged, the guard would
   * be pushing people AWAY from the fix: countryGeocoder's tombstone reclaim
   * is an upper bound against the clock, and it is the correct answer there.
   */
  it("an upper bound against the clock is not a site at all", () => {
    assert.deepEqual(
      sitesIn("snippet.ts", `
        async function reclaim(db: any) {
          const before = new Date(Date.now() - 24 * 3600_000).toISOString();
          return db.from("cache").delete().lt("deleted_at", before);
        }
      `),
      [],
    );
  });

  it("a lower bound at now itself is absolute, not a window", () => {
    assert.equal(
      verdictOf(`
        async function live(db: any) {
          return db.from("snapshots").select("id").gt("expires_at", new Date().toISOString());
        }
      `),
      "absolute",
    );
  });

  it("the `expires_at.is.null,expires_at.gt.<now>` or-filter idiom is absolute", () => {
    const s = only(`
      async function live(db: any) {
        const now = new Date().toISOString();
        return db.from("trust_caps").select("id").or(\`expires_at.is.null,expires_at.gt.\${now}\`);
      }
    `);
    assert.equal(s.verdict, "absolute");
    assert.equal(s.column, "expires_at");
  });

  /** A bounding box and a keyset cursor are lower bounds, and neither is time. */
  it("a non-temporal column with a non-clock bound is not judged", () => {
    assert.equal(
      verdictOf(`
        async function nearby(db: any, lat: number) {
          return db.from("places").select("id").gte("latitude", lat - 0.1);
        }
      `),
      "not-time",
    );
    assert.equal(isTemporalColumn("latitude"), false);
    assert.equal(isTemporalColumn("created_at"), true);
    assert.equal(isTemporalColumn("time_bucket"), true);
    assert.equal(isTemporalColumn("start_date"), true);
  });

  it("a window wider than the plausible gap is out of scope, and the boundary is inclusive", () => {
    const wide = only(`
      async function rings(db: any) {
        const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
        return db.from("reviews").select("id").eq("rating", 5).gte("created_at", since);
      }
    `);
    assert.equal(wide.verdict, "wider-than-gap");
    assert.equal(
      verdictOf(`
        async function pods(db: any) {
          const since = new Date(Date.now() - 72 * 3600_000).toISOString();
          return db.from("comments").select("id").gte("created_at", since);
        }
      `),
      "wider-than-gap",
      "a window of exactly PLAUSIBLE_GAP_MS covers the gap it is compared against",
    );
    assert.equal(
      verdictOf(`
        async function pods(db: any) {
          const since = new Date(Date.now() - (72 * 3600_000 - 1)).toISOString();
          return db.from("comments").select("id").gte("created_at", since);
        }
      `),
      "bare",
      "one millisecond under the gap is in scope — the boundary must be a real boundary",
    );
  });

  it("a chain pinned to a runtime entity is out of scope; a chain pinned only by literals is not", () => {
    assert.equal(
      verdictOf(`
        async function forUser(db: any, userId: string) {
          const since = new Date(Date.now() - 3600_000).toISOString();
          return db.from("trust_events").select("id").eq("user_id", userId).gte("created_at", since);
        }
      `),
      "entity-scoped",
    );
    assert.equal(
      verdictOf(`
        const KINDS = ["applied", "confirmed"];
        async function dirty(db: any) {
          const since = new Date(Date.now() - 3600_000).toISOString();
          return db.from("trust_events").select("id").in("status", [...KINDS]).gte("created_at", since);
        }
      `),
      "bare",
      "a filter over a constant list does not choose the rows — the window still does",
    );
  });

  /** tripReminderScheduler's shape: the band points forward and still moves past a row. */
  it("a forward band is a site, and its width is reported as being in the future", () => {
    const s = only(`
      async function remind(db: any) {
        const lower = new Date(Date.now() + 22 * 3600_000).toISOString();
        return db.from("trips").select("id").is("reminder_sent_at", null).gte("start_date", lower.slice(0, 10));
      }
    `);
    assert.equal(s.verdict, "bare");
    assert.ok(s.widthMs !== null && s.widthMs < 0, `expected a future bound, got ${String(s.widthMs)}`);
  });

  it("a relative lower bound spelled out in SQL text is a site", () => {
    const sites = sitesIn("snippet.ts", "const q = `select 1 from rank_events where served_at >= now() - interval '2 hours'`;");
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.verdict, "bare");
    assert.equal(sites[0]!.column, "served_at");
  });

  /**
   * THE HONESTY CASE. An exported function's parameter can be anything, so the
   * span cannot be established — and "cannot establish" must FAIL, not pass.
   */
  it("a bound this tracer cannot establish is unresolved, not waved through", () => {
    const s = only(`
      export async function sweep(db: any, sinceIso: string) {
        return db.from("messages").select("id").gte("created_at", sinceIso);
      }
    `);
    assert.equal(s.verdict, "unresolved");
    assert.equal(s.provenance.cls, "unknown");
  });

  it("two sites with the same structural key are kept apart by an index suffix", () => {
    const sites = sitesIn("snippet.ts", `
      async function twice(db: any) {
        const since = new Date(Date.now() - 3600_000).toISOString();
        await db.from("t").select("a").gte("created_at", since);
        await db.from("t").select("b").gte("created_at", since);
      }
    `);
    assert.deepEqual(sites.map((s) => s.key), [
      'snippet.ts::twice::t.gte("created_at")',
      'snippet.ts::twice::t.gte("created_at")#2',
    ]);
  });
});

describe("the allowlist cannot rot", () => {
  it("every entry has a usable reason, a label where one is required, and a unique key", () => {
    const seen = new Set<string>();
    for (const e of ALLOWLIST) {
      assert.ok(!seen.has(e.key), `duplicate allowlist key ${e.key}`);
      seen.add(e.key);
      assert.ok(
        e.reason.trim().length >= MIN_REASON_CHARS,
        `${e.key}: reason is ${e.reason.trim().length} chars, needs ${MIN_REASON_CHARS}`,
      );
      if (e.kind === "known_defect") {
        assert.ok(
          DEFECT_LABELS.some((l) => e.reason.trim().startsWith(l)),
          `${e.key}: a known_defect note must start with ${DEFECT_LABELS.join(" or ")}`,
        );
      }
    }
  });

  it("an entry whose site no longer FAILS is stale", () => {
    const entry: AllowEntry = { key: "gone.ts::f::t.gte(\"created_at\")", kind: "governed", reason: "x".repeat(MIN_REASON_CHARS) };
    const v = applyAllowlist([], [entry]);
    assert.deepEqual(v.stale, [entry.key]);
  });

  it("an entry covering a site that is now watermarked is stale, so the entry has to be deleted", () => {
    const watermarked = sitesIn("ok.ts", `
      import { scanWindow } from "../lib/schedulerWatermark.js";
      async function detect(db: any, now: Date) {
        const win = scanWindow({ watermark: null, now, defaultLookbackMs: 1, maxCatchupMs: 2 });
        return db.from("t").select("id").gte("created_at", win.since.toISOString());
      }
    `);
    assert.equal(watermarked[0]!.verdict, "watermarked");
    const v = applyAllowlist(watermarked, [
      { key: watermarked[0]!.key, kind: "governed", reason: "y".repeat(MIN_REASON_CHARS) },
    ]);
    assert.deepEqual(v.stale, [watermarked[0]!.key]);
    assert.deepEqual(v.violations, []);
  });

  /**
   * THE DRIFT THAT MATTERS MOST. Three entries say "this IS watermarked, by a
   * route the trace cannot follow". If the watermark is later deleted those
   * entries would keep the sites green forever. `requires` is the inspection
   * proof that stops it.
   */
  it("an entry whose `requires` text has left its file is unjustified, and its site fails again", () => {
    const bare = sitesIn("x.ts", `
      async function pass(db: any) {
        const since = new Date(Date.now() - 3600_000).toISOString();
        return db.from("t").select("id").gte("created_at", since);
      }
    `);
    const entry: AllowEntry = {
      key: bare[0]!.key,
      kind: "governed",
      reason: "z".repeat(MIN_REASON_CHARS),
      requires: ["scanWindow("],
    };
    const restore = setFileHolds(() => true);
    try {
      const ok = applyAllowlist(bare, [entry]);
      assert.deepEqual(ok.violations, [], "with the proof present the entry governs the site");
      assert.deepEqual(ok.unjustified, []);
      setFileHolds(() => false);
      const gone = applyAllowlist(bare, [entry]);
      assert.equal(gone.violations.length, 1, "with the proof gone the site must fail again");
      assert.equal(gone.unjustified.length, 1);
    } finally {
      setFileHolds(restore);
    }
  });

  it("every `requires` text is really in its file today", () => {
    for (const e of ALLOWLIST) {
      const file = e.key.split("::")[0]!;
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      for (const needle of e.requires ?? []) {
        assert.ok(text.includes(needle), `${e.key}: requires \`${needle}\`, which ${file} does not contain`);
      }
    }
  });
});

describe("the tree as it stands", () => {
  const scan = scanTree();
  const verdict = applyAllowlist(scan.sites, ALLOWLIST);

  it("every scheduler in the registry has a file, so reachability is not silently empty", () => {
    const tree = readTree();
    assert.deepEqual(tree.ownerless, [], "these start…() functions are listed but no file exports them");
    assert.equal(tree.owners.size, 62); // 62 with lane T-REL's startMessageMediaPartsSweepScheduler (census-telegraph T223, 3656); 58 until #549 (startDiscoveryServeLogRetentionScheduler) was integrated beside this guard; 60 since lane R added startLayoverAuditRetentionScheduler (census-layover L163, 2026-10-07); 61 with lane H's startMemoryDeletionRedriveScheduler (census-highlights-memories §AF/§AV)
    assert.ok(tree.reachable.size > 100, `only ${tree.reachable.size} files reachable — the import walk is broken`);
  });

  it("the scan is not vacuous", () => {
    assert.deepEqual(scan.parseFailures, []);
    assert.ok(scan.sites.length > 50, `only ${scan.sites.length} lower bounds judged`);
    assert.ok(
      scan.sites.some((s) => s.verdict === "watermarked"),
      "no watermarked window found at all — the prover is broken and everything else is meaningless",
    );
  });

  it("no site is a violation today", () => {
    assert.deepEqual(
      verdict.violations.map((s) => s.key),
      [],
      "a scheduled job selects work with a relative window and neither a watermark nor an allowlist entry",
    );
    assert.deepEqual(verdict.stale, []);
    assert.deepEqual(verdict.unjustified, []);
    assert.deepEqual(verdict.duplicated, []);
  });

  /**
   * MUTATION, IN MEMORY. The watermarked span in
   * TrustGamingDetectionService#detectCheckinClusters is replaced with the
   * bare window it used to be, and the verdict must flip. This is the proof
   * that the PASS on that file is a measurement and not an accident of the
   * tracer failing to find anything.
   */
  it("re-introducing the bare window at a fixed site turns it back into a violation", () => {
    const rel = "services/trust/TrustGamingDetectionService.ts";
    const text = readFileSync(join(SRC_ROOT, rel), "utf8");
    const key = `${rel}::detectCheckinClusters::plan_attendance_events.gt("created_at")`;
    assert.equal(
      sitesIn(rel, text).find((s) => s.key === key)?.verdict,
      "watermarked",
      "the site under test is not watermarked as it stands — this test is pointing at the wrong line",
    );

    const mutated = text.replace(
      '.gt("created_at", win.sinceIso)',
      '.gt("created_at", new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString())',
    );
    assert.notEqual(mutated, text, "the mutation matched nothing — the expression has moved");
    const after = sitesIn(rel, mutated).find((s) => s.key === key);
    assert.equal(after?.verdict, "bare", "the guard did not notice the window losing its watermark");
    assert.equal(after?.widthMs, 24 * 60 * 60 * 1000);
    assert.ok(
      applyAllowlist(sitesIn(rel, mutated), ALLOWLIST).violations.some((s) => s.key === key),
      "the mutated site must be a VIOLATION, not merely re-labelled — nothing in ALLOWLIST may cover it",
    );
  });

  it("PLAUSIBLE_GAP_MS is the 72 hours the docblock argues for", () => {
    assert.equal(PLAUSIBLE_GAP_MS, 72 * 60 * 60 * 1000);
  });
});
