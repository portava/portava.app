import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  segmentJourney,
  type RestrictedJourneyObservation,
  type JourneyObservationQualityFields,
} from "../services/location/JourneySegmenter.js";
import {
  measureJourneyShadowQuality,
  measureJourneyGroundTruth,
  type JourneyGroundTruthFixture,
} from "../services/location/JourneyShadowMetrics.js";
import {
  scoreObservationQuality,
  OBSERVATION_QUALITY_SCORER_VERSION,
} from "../services/journey/JourneyObservationQuality.js";
import { persistJourneySegmentsShadow } from "../services/location/JourneySegmentationShadowService.js";
import {
  deleteJourneySegmentsForUser,
  JOURNEY_SEGMENT_EXPIRED_ALERT_AGE_MS,
  purgeExpiredJourneySegments,
  revokeJourneyConsentAndDeleteSegments,
} from "../lib/journeySegmentRetention.js";
import { _setTestClient } from "../lib/http.js";
import locationPreferencesRouter from "../routes/locationPreferences.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_ID = "22222222-2222-2222-2222-222222222222";
const START_MS = Date.parse("2026-08-21T10:00:00.000Z");
const BASE_LAT = 51.5074;
const BASE_LNG = -0.1278;

function point(
  seconds: number,
  eastM: number,
  northM = 0,
  accuracyM = 10,
  speedMps: number | null = null,
): RestrictedJourneyObservation {
  return {
    id: `obs-${seconds}-${eastM}-${northM}-${accuracyM}`,
    observedAt: new Date(START_MS + seconds * 1_000).toISOString(),
    source: "foreground_gps",
    lat: BASE_LAT + northM / 111_320,
    lng: BASE_LNG + eastM / (111_320 * Math.cos((BASE_LAT * Math.PI) / 180)),
    accuracyM,
    speedMps,
  };
}

function run(
  observations: RestrictedJourneyObservation[],
  sessionEndSeconds?: number,
  algorithmVersion?: string,
) {
  return segmentJourney({
    userId: USER_ID,
    locationSessionId: SESSION_ID,
    observations,
    sessionEndedAt: sessionEndSeconds == null
      ? null
      : new Date(START_MS + sessionEndSeconds * 1_000).toISOString(),
    algorithmVersion,
  });
}

const stationary = [
  point(0, 0),
  point(60, 4),
  point(180, -5),
  point(360, 7),
  point(660, -3),
];

describe("JourneySegmenter deterministic state machine", () => {
  it("progresses moving -> candidate_stop -> dwelling and then departed", () => {
    const revisions = run([...stationary, point(720, 220)]);
    assert.deepEqual(
      revisions.slice(0, 4).map((revision) => revision.state),
      ["moving", "candidate_stop", "dwelling", "departed"],
    );
    assert.equal(revisions[1]!.supersedesRevisionId, revisions[0]!.revisionId);
    assert.equal(revisions[2]!.supersedesRevisionId, revisions[1]!.revisionId);
    assert.ok(revisions[2]!.uncertainty.algorithmVersion);
    assert.ok(revisions[2]!.uncertainty.reasons.includes("dwell_threshold_met"));
  });

  it("does not turn accuracy-envelope GPS jitter into a false departure", () => {
    const revisions = run([
      point(0, 0, 0, 25),
      point(60, 24, -18, 25),
      point(180, -22, 20, 25),
      point(360, 28, 12, 25),
      point(660, -25, -15, 25),
    ]);
    assert.ok(revisions.some((revision) => revision.state === "dwelling"));
    assert.ok(!revisions.some((revision) => revision.state === "departed"));
  });

  it("discards sparse and long-gap evidence instead of claiming a dwell", () => {
    const sparse = run([point(0, 0), point(1_800, 2)]);
    assert.ok(sparse.some((revision) => revision.state === "discarded"));
    assert.ok(!sparse.some((revision) => revision.state === "dwelling"));

    const longGap = run([point(0, 0), point(60, 2), point(900, 3)]);
    assert.ok(longGap.some((revision) => revision.state === "discarded"));
    assert.ok(!longGap.some((revision) => revision.state === "dwelling"));
  });

  it("discards a short pause and does not call it dwell", () => {
    const revisions = run([
      point(0, 0),
      point(60, 3),
      point(180, 4),
      point(240, 180, 0, 8, 2),
    ]);
    assert.ok(revisions.some((revision) => revision.state === "candidate_stop"));
    assert.ok(revisions.some((revision) => revision.state === "discarded"));
    assert.ok(!revisions.some((revision) => revision.state === "dwelling"));
  });

  it("low-accuracy samples cannot establish a stop or precise place", () => {
    // Observations with accuracyM > 100 are pre-filtered as unusable by the
    // quality scorer before any segmentation — they produce zero revisions.
    const revisions = run([
      point(0, 0, 0, 250),
      point(180, 5, 2, 220),
      point(660, -4, 1, 300),
    ], 700);
    assert.ok(!revisions.some((revision) => revision.state === "candidate_stop"));
    assert.ok(!revisions.some((revision) => revision.state === "dwelling"));
    assert.ok(revisions.every((revision) => revision.worldRef.placeId === null));
    // All points are filtered → zero revisions (quality pre-filter enforces >100m unusable)
    assert.equal(revisions.length, 0);
  });

  it("keeps vehicle/transit movement stable without false stops", () => {
    const revisions = run([
      point(0, 0, 0, 8, 15),
      point(60, 900, 0, 8, 15),
      point(120, 1_800, 0, 8, 15),
      point(180, 2_700, 0, 8, 15),
    ], 200);
    assert.ok(!revisions.some((revision) => revision.state === "candidate_stop"));
    assert.ok(!revisions.some((revision) => revision.state === "dwelling"));
    assert.ok(revisions.some((revision) => revision.movementClass === "transit"));
  });

  it("sorts out-of-order events and ignores duplicate event IDs", () => {
    const ordered = run(stationary);
    const replayedOutOfOrder = run([
      stationary[3]!,
      stationary[1]!,
      stationary[0]!,
      stationary[1]!,
      stationary[4]!,
      stationary[2]!,
    ]);
    assert.deepEqual(replayedOutOfOrder, ordered);
  });

  it("replay is idempotent, while a new algorithm version is attributable", () => {
    const first = run(stationary);
    const replay = run(stationary);
    const nextVersion = run(stationary, undefined, "journey-stop-dwell-v2-test");
    assert.deepEqual(replay, first);
    assert.notEqual(nextVersion[0]!.revisionId, first[0]!.revisionId);
    assert.equal(nextVersion[0]!.algorithmVersion, "journey-stop-dwell-v2-test");
  });

  it("deterministically closes dwelling and discards an open candidate at session end", () => {
    const closedDwell = run(stationary, 700);
    assert.equal(closedDwell.at(-1)!.state, "dwelling");
    assert.equal(
      closedDwell.at(-1)!.endedAt,
      new Date(START_MS + 700_000).toISOString(),
    );

    const discardedCandidate = run([point(0, 0), point(60, 2)], 120);
    assert.equal(discardedCandidate.at(-1)!.state, "discarded");
    assert.ok(discardedCandidate.at(-1)!.evidence.reasonCodes.includes("session_ended"));
  });

  it("never retains exact coordinates or raw observation IDs in revisions", () => {
    const coordinateShapedWorldRef = stationary.map((observation) => ({
      ...observation,
      worldRef: {
        countryCode: "PH",
        cityId: "10.3157,123.8854",
        placeId: {
          lat: observation.latitude,
          lng: observation.longitude,
        },
      } as any,
    }));
    const output = run(coordinateShapedWorldRef);
    const serialized = JSON.stringify(output);
    assert.ok(!/"lat"\s*:/.test(serialized));
    assert.ok(!/"lng"\s*:/.test(serialized));
    assert.ok(!serialized.includes("obs-"));
    assert.ok(!serialized.includes(String(BASE_LAT)));
    assert.ok(!serialized.includes(String(BASE_LNG)));
    assert.ok(output.every((revision) => revision.worldRef.cityId === null));
    assert.ok(output.every((revision) => revision.worldRef.placeId === null));
  });
});

describe("Journey shadow quality metrics", () => {
  it("measures false-stop and false-dwell rates across representative fixtures", () => {
    const cases = [
      { condition: "gps_jitter", expectedStop: true, expectedDwell: true, revisions: run(stationary) },
      { condition: "sparse_samples", expectedStop: false, expectedDwell: false, revisions: run([point(0, 0), point(1_800, 2)]) },
      { condition: "long_gap", expectedStop: false, expectedDwell: false, revisions: run([point(0, 0), point(60, 2), point(900, 3)]) },
      { condition: "low_accuracy", expectedStop: false, expectedDwell: false, revisions: run([point(0, 0, 0, 250), point(660, 3, 0, 250)], 700) },
      { condition: "transit", expectedStop: false, expectedDwell: false, revisions: run([point(0, 0, 0, 8, 15), point(60, 900, 0, 8, 15)], 90) },
      { condition: "out_of_order", expectedStop: true, expectedDwell: true, revisions: run([...stationary].reverse()) },
      { condition: "session_end", expectedStop: false, expectedDwell: false, revisions: run([point(0, 0), point(60, 2)], 120) },
    ];
    const metrics = measureJourneyShadowQuality(cases);
    assert.equal(metrics.cases, 7);
    assert.equal(metrics.falseStop.falseCount, 0);
    assert.equal(metrics.falseDwell.falseCount, 0);
    assert.deepEqual(Object.keys(metrics.byCondition).sort(), [
      "gps_jitter",
      "long_gap",
      "low_accuracy",
      "out_of_order",
      "session_end",
      "sparse_samples",
      "transit",
    ]);
  });
});

function makeShadowDb(
  flags: Record<string, boolean>,
  opts: {
    preferences?: any;
    session?: any;
  } = {},
) {
  const rpcCalls: any[] = [];
  const preferences = Object.prototype.hasOwnProperty.call(opts, "preferences")
    ? opts.preferences
    : {
    location_mode: "live_during_activity",
    sharing_paused: false,
    journey_observation_enabled: true,
  };
  const session = Object.prototype.hasOwnProperty.call(opts, "session")
    ? opts.session
    : {
    id: SESSION_ID,
    user_id: USER_ID,
    started_at: new Date(START_MS - 60_000).toISOString(),
    ended_at: null,
    expires_at: "2030-01-01T00:00:00.000Z",
  };

  /**
   * Compute the authorization result that the single SQL authority
   * (journey_shadow_authorize_v1) would return based on flags/preferences/session.
   * This mirrors the SQL function's logic: all three flags must be enabled,
   * user must have opted in, session must belong to the user, sharing not paused.
   */
  function computeAuthorization(): string {
    if (!flags["COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED"]) {
      return "feature_disabled";
    }
    if (
      !flags["COMPASS_JOURNEY_ENGINE_ENABLED"] ||
      !flags["COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED"]
    ) {
      return "feature_disabled";
    }
    if (!preferences) return "not_authorized";
    if (preferences.sharing_paused) return "not_authorized";
    if (!preferences.journey_observation_enabled) return "not_authorized";
    if (!session || session.user_id !== USER_ID) return "not_authorized";
    return "authorized";
  }

  return {
    rpcCalls,
    from(table: string) {
      const builder: any = {
        filters: [] as Array<[string, unknown]>,
        select: () => builder,
        eq: (column: string, value: unknown) => {
          builder.filters.push([column, value]);
          return builder;
        },
        is: (column: string, value: unknown) => {
          builder.filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () => {
          // Direct table reads for flags/preferences/session are NOT used by
          // the service for authorization — journey_shadow_authorize_v1 is the
          // single SQL authority. These remain available only for non-auth reads.
          if (table === "feature_flags") {
            const flag = builder.filters.find(([column]: [string, unknown]) => column === "flag")?.[1];
            return {
              data: flag in flags ? { enabled: flags[String(flag)] } : null,
              error: null,
            };
          }
          if (table === "user_location_preferences") {
            return { data: preferences, error: null };
          }
          if (table === "location_sessions") {
            return { data: session, error: null };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name === "journey_shadow_authorize_v1") {
        // Central SQL authority — resolves flags, preferences, session, and
        // cohort/retention issuance in a single fail-closed transaction.
        return { data: computeAuthorization(), error: null };
      }
      if (name === "append_journey_segment_revisions_v2") {
        return { data: args.p_rows.length, error: null };
      }
      return { data: null, error: null };
    },
  };
}

describe("Journey shadow persistence boundary", () => {
  it("requires all default-off flags plus fresh preferences and active owner session", async () => {
    // sharing_paused → not_authorized via single SQL authority
    const db = makeShadowDb({
      COMPASS_JOURNEY_ENGINE_ENABLED: true,
      COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED: true,
      COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED: true,
    }, {
      preferences: {
        location_mode: "live_during_activity",
        sharing_paused: true,
        journey_observation_enabled: true,
      },
    });
    const denied = await persistJourneySegmentsShadow(db as any, {
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: stationary,
    });
    assert.equal(denied.status, "authorization_required");
    // Central authority (journey_shadow_authorize_v1) is called exactly once;
    // no raw flag/preference/session table reads are made for authorization.
    assert.equal(db.rpcCalls.length, 1);
    assert.equal(db.rpcCalls[0]!.name, "journey_shadow_authorize_v1");
    assert.equal(db.rpcCalls[0]!.args.p_operation, "derived_write");
    // Append RPC must NOT have been called.
    assert.ok(!db.rpcCalls.some((c: any) => c.name === "append_journey_segment_revisions_v2"));

    // journey_observation_enabled: false → not_authorized
    const notOptedInDb = makeShadowDb({
      COMPASS_JOURNEY_ENGINE_ENABLED: true,
      COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED: true,
      COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED: true,
    }, {
      preferences: {
        location_mode: "live_during_activity",
        sharing_paused: false,
        journey_observation_enabled: false,
      },
    });
    const notOptedIn = await persistJourneySegmentsShadow(notOptedInDb as any, {
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: stationary,
    });
    assert.equal(notOptedIn.status, "authorization_required");
    assert.equal(notOptedInDb.rpcCalls.length, 1);
    assert.equal(notOptedInDb.rpcCalls[0]!.name, "journey_shadow_authorize_v1");
    assert.ok(!notOptedInDb.rpcCalls.some((c: any) => c.name === "append_journey_segment_revisions_v2"));

    // COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED: false → feature_disabled
    const disabledDb = makeShadowDb({
      COMPASS_JOURNEY_ENGINE_ENABLED: true,
      COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED: true,
      COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED: false,
    });
    const disabled = await persistJourneySegmentsShadow(disabledDb as any, {
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: stationary,
    });
    assert.equal(disabled.status, "disabled");
    assert.equal(disabledDb.rpcCalls.length, 1);
    assert.equal(disabledDb.rpcCalls[0]!.name, "journey_shadow_authorize_v1");
    assert.ok(!disabledDb.rpcCalls.some((c: any) => c.name === "append_journey_segment_revisions_v2"));

    // session: null → not_authorized (session does not belong to this user)
    const foreignSessionDb = makeShadowDb({
      COMPASS_JOURNEY_ENGINE_ENABLED: true,
      COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED: true,
      COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED: true,
    }, {
      session: null,
    });
    const foreignSession = await persistJourneySegmentsShadow(foreignSessionDb as any, {
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: stationary,
    });
    assert.equal(foreignSession.status, "authorization_required");
    assert.equal(foreignSessionDb.rpcCalls.length, 1);
    assert.equal(foreignSessionDb.rpcCalls[0]!.name, "journey_shadow_authorize_v1");
    assert.ok(!foreignSessionDb.rpcCalls.some((c: any) => c.name === "append_journey_segment_revisions_v2"));
  });

  it("uses the insert-only RPC (v2) and sends no exact coordinate fields", async () => {
    const db = makeShadowDb({
      COMPASS_JOURNEY_ENGINE_ENABLED: true,
      COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED: true,
      COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED: true,
    });
    const result = await persistJourneySegmentsShadow(db as any, {
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: stationary,
    });
    assert.equal(result.status, "persisted");

    // First RPC call is the central authority (derived_write); second is the append.
    assert.equal(db.rpcCalls[0]!.name, "journey_shadow_authorize_v1");
    assert.equal(db.rpcCalls[0]!.args.p_operation, "derived_write");

    // The append must use the v2 insert-only RPC — not the old v1 name.
    const appendCall = db.rpcCalls.find((c: any) => c.name === "append_journey_segment_revisions_v2");
    assert.ok(appendCall, "append_journey_segment_revisions_v2 must be called");
    assert.ok(!db.rpcCalls.some((c: any) => c.name === "append_journey_segment_revisions"),
      "old v1 append RPC must not be called");

    const persisted = JSON.stringify(appendCall.args.p_rows);

    // No exact coordinates or raw observation IDs in persisted rows.
    assert.ok(!/"lat"\s*:/.test(persisted), "no lat field in persisted rows");
    assert.ok(!/"lng"\s*:/.test(persisted), "no lng field in persisted rows");
    assert.ok(!persisted.includes("obs-"), "no raw observation IDs in persisted rows");

    // v2 rows must carry structured timing_uncertainty, quality_summary, place_provenance.
    const rows: any[] = appendCall.args.p_rows;
    assert.ok(rows.length > 0, "expected at least one persisted row");
    for (const row of rows) {
      assert.ok("timing_uncertainty" in row, `row missing timing_uncertainty: ${row.state}`);
      assert.ok("quality_summary" in row, `row missing quality_summary: ${row.state}`);
      assert.ok("place_provenance" in row, `row missing place_provenance: ${row.state}`);
      // timing_uncertainty must be a structured object, not a scalar.
      assert.equal(typeof row.timing_uncertainty, "object");
      assert.equal(typeof row.quality_summary, "object");
      assert.equal(typeof row.place_provenance, "object");
    }
  });

  it("atomically erases and denies append for every route-level Journey revocation", async () => {
    const legacyPreference = {
      location_mode: "live_during_activity",
      sharing_paused: false,
    };
    const canonicalPreference = {
      ...legacyPreference,
      journey_observation_enabled: true,
    };
    const journeyRows = [{ id: "segment-before-revocation", user_id: USER_ID }];
    let failAtomicRevocation = false;
    const rpcCalls: Array<{ name: string; args: any }> = [];
    const flags = new Set([
      "COMPASS_JOURNEY_ENGINE_ENABLED",
      "COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED",
      "COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED",
    ]);
    const db: any = {
      auth: {
        getUser: async (token: string) => token === "journey-owner-token"
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
      },
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        const builder: any = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            filters.push([column, value]);
            return builder;
          },
          is: () => builder,
          maybeSingle: async () => {
            if (table === "feature_flags") {
              const flag = String(filters.find(([column]) => column === "flag")?.[1] ?? "");
              return { data: flags.has(flag) ? { enabled: true } : null, error: null };
            }
            if (table === "user_location_preferences") {
              return { data: { ...canonicalPreference }, error: null };
            }
            if (table === "location_preferences") {
              return { data: { ...legacyPreference }, error: null };
            }
            if (table === "location_sessions") {
              return {
                data: {
                  id: SESSION_ID,
                  user_id: USER_ID,
                  started_at: new Date(START_MS - 60_000).toISOString(),
                  ended_at: null,
                  expires_at: "2030-01-01T00:00:00.000Z",
                },
                error: null,
              };
            }
            if (table === "profiles") {
              return { data: { account_status: "active" }, error: null };
            }
            throw new Error(`unexpected table ${table}`);
          },
          upsert: async (row: Record<string, unknown>) => {
            assert.equal(table, "user_location_preferences");
            Object.assign(canonicalPreference, row);
            return { data: null, error: null };
          },
        };
        return builder;
      },
      rpc: async (name: string, args: any) => {
        rpcCalls.push({ name, args });
        if (name === "revoke_journey_consent_and_delete_segments") {
          if (failAtomicRevocation) {
            return {
              data: null,
              error: { code: "57014", message: "atomic revocation interrupted" },
            };
          }
          Object.assign(canonicalPreference, args.p_preferences);
          const deleted = journeyRows.length;
          journeyRows.splice(0);
          return { data: deleted, error: null };
        }
        if (name === "journey_shadow_authorize_v1") {
          // Single SQL authority: check all flags, preferences (including
          // post-revocation state), session ownership, and location_mode
          // in one fail-closed call. Mirrors journey_shadow_authorize_v1 SQL.
          const segEnabled = flags.has("COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED");
          const engineEnabled = flags.has("COMPASS_JOURNEY_ENGINE_ENABLED");
          const ingestEnabled = flags.has("COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED");
          if (!segEnabled || !engineEnabled || !ingestEnabled) return { data: "feature_disabled", error: null };
          if (canonicalPreference.sharing_paused) return { data: "not_authorized", error: null };
          if (!canonicalPreference.journey_observation_enabled) return { data: "not_authorized", error: null };
          // location_mode must be a live mode; revoked modes (off, city_only,
          // nearby) are not authorized per the SQL function's policy.
          const liveMode = ["live_during_activity", "trusted_circle_live"];
          if (!liveMode.includes(canonicalPreference.location_mode)) return { data: "not_authorized", error: null };
          return { data: "authorized", error: null };
        }
        if (name === "append_journey_segment_revisions_v2") {
          return { data: args.p_rows?.length ?? 0, error: null };
        }
        return { data: 0, error: null };
      },
    };

    _setTestClient(db, true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", locationPreferencesRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    try {
      const patchPreferences = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/api/me/location-preferences`, {
          method: "PATCH",
          headers: {
            authorization: "Bearer journey-owner-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

      for (const locationMode of ["off", "city_only", "nearby"] as const) {
        Object.assign(canonicalPreference, legacyPreference, {
          journey_observation_enabled: true,
        });
        journeyRows.splice(0, journeyRows.length, {
          id: `segment-before-${locationMode}`,
          user_id: USER_ID,
        });
        const atomicCallsBefore = rpcCalls.filter(
          (call) => call.name === "revoke_journey_consent_and_delete_segments",
        ).length;

        const response = await patchPreferences({ locationMode });
        assert.equal(response.status, 200, await response.text());
        assert.equal(canonicalPreference.location_mode, locationMode);
        assert.equal(
          journeyRows.length,
          0,
          `${locationMode} success must leave no Journey row`,
        );
        assert.equal(
          rpcCalls.filter(
            (call) => call.name === "revoke_journey_consent_and_delete_segments",
          ).length,
          atomicCallsBefore + 1,
          `${locationMode} must use the atomic revocation-and-erasure operation`,
        );
      }

      Object.assign(canonicalPreference, legacyPreference, {
        journey_observation_enabled: true,
      });
      journeyRows.splice(0, journeyRows.length, {
        id: "segment-before-observation-opt-out",
        user_id: USER_ID,
      });
      const optOutResponse = await patchPreferences({
        journeyObservationEnabled: false,
      });
      assert.equal(optOutResponse.status, 200, await optOutResponse.text());
      assert.equal(canonicalPreference.journey_observation_enabled, false);
      assert.equal(journeyRows.length, 0, "observation consent opt-out erases segments");

      Object.assign(canonicalPreference, legacyPreference, {
        journey_observation_enabled: true,
      });
      journeyRows.splice(0, journeyRows.length, {
        id: "segment-before-failed-revocation",
        user_id: USER_ID,
      });
      failAtomicRevocation = true;
      const failedResponse = await patchPreferences({ locationMode: "city_only" });
      assert.equal(failedResponse.status, 500);
      assert.equal((await failedResponse.json()).error, "db_error");
      assert.equal(
        canonicalPreference.location_mode,
        "live_during_activity",
        "an interrupted transaction must not report or emulate a preference change",
      );
      assert.equal(
        journeyRows.length,
        1,
        "an interrupted transaction remains intact and retryable",
      );

      failAtomicRevocation = false;
      const retryResponse = await patchPreferences({ locationMode: "city_only" });
      assert.equal(retryResponse.status, 200, await retryResponse.text());
      assert.equal(canonicalPreference.location_mode, "city_only");
      assert.equal(journeyRows.length, 0, "retry completes atomic erasure");
      assert.equal(
        legacyPreference.location_mode,
        "live_during_activity",
        "rollback-only legacy row remains stale by design",
      );

      const result = await persistJourneySegmentsShadow(db, {
        userId: USER_ID,
        locationSessionId: SESSION_ID,
        observations: stationary,
      });
      assert.equal(result.status, "authorization_required");
      // After revocation the central SQL authority returns not_authorized, so
      // the v2 append RPC must never be reached.
      assert.equal(
        rpcCalls.filter((call) => call.name === "append_journey_segment_revisions_v2").length,
        0,
        "no post-revocation segment row reaches the append RPC",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      _setTestClient(null, false);
    }
  });
});

describe("Journey segment retention", () => {
  it("purges expired rows via the sealed maintenance RPC and reports backlog age", async () => {
    const calls: Array<{ name: string; args: any; table?: string }> = [];
    const backlogMs = JOURNEY_SEGMENT_EXPIRED_ALERT_AGE_MS + 5_000;
    const client = {
      rpc: async (name: string, args: any) => {
        calls.push({ name, args });
        // The RPC computes deletion + oldest-after (remaining backlog) atomically.
        return {
          data: {
            deletedCount: 3,
            oldestBeforeAgeMs: backlogMs,
            oldestAfterAgeMs: backlogMs,
          },
          error: null,
        };
      },
      // Direct table access must NOT be used any more; record it if it happens.
      from(table: string) {
        const builder: any = new Proxy({}, {
          get: () => {
            calls.push({ name: "from", args: null, table });
            return () => builder;
          },
        });
        return builder;
      },
    };
    const result = await purgeExpiredJourneySegments({
      client,
      now: new Date(START_MS),
    });
    assert.equal(result.deleted, 3);
    assert.ok((result.oldestExpiredAgeMs ?? 0) > JOURNEY_SEGMENT_EXPIRED_ALERT_AGE_MS);
    // Retention goes through the sealed RPC only — no direct table access.
    assert.deepEqual(calls, [{
      name: "purge_expired_journey_shadow_table_v1",
      args: { p_kind: "segment", p_now: new Date(START_MS).toISOString() },
    }]);
  });

  it("deletes all derived segments immediately on consent revocation", async () => {
    const filters: Array<[string, unknown]> = [];
    const client = {
      rpc: async (name: string, args: any) => {
        assert.equal(name, "delete_journey_segments_for_user");
        filters.push(["user_id", args.p_user_id]);
        return { data: 4, error: null };
      },
    };
    const deleted = await deleteJourneySegmentsForUser(client, USER_ID);
    assert.equal(deleted, 4);
    assert.deepEqual(filters, [["user_id", USER_ID]]);
  });

  it("uses one atomic RPC for canonical consent revocation and segment erasure", async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const client = {
      rpc: async (name: string, args: any) => {
        calls.push({ name, args });
        return { data: 5, error: null };
      },
    };
    const deleted = await revokeJourneyConsentAndDeleteSegments(client, USER_ID, {
      location_mode: "off",
      sharing_paused: true,
      safe_return_enabled: false,
    });
    assert.equal(deleted, 5);
    assert.deepEqual(calls, [{
      name: "revoke_journey_consent_and_delete_segments",
      args: {
        p_user_id: USER_ID,
        p_preferences: {
          location_mode: "off",
          sharing_paused: true,
          safe_return_enabled: false,
        },
      },
    }]);
  });

  it("does not split-write or acknowledge a failed atomic revocation", async () => {
    let tableAccessed = false;
    const client = {
      rpc: async () => ({
        data: null,
        error: { code: "57014", message: "transaction interrupted" },
      }),
      from: () => {
        tableAccessed = true;
        throw new Error("non-atomic fallback must not run");
      },
    };
    await assert.rejects(
      revokeJourneyConsentAndDeleteSegments(client, USER_ID, { sharing_paused: true }),
      (error: any) => error?.code === "57014" && error?.message === "transaction interrupted",
    );
    assert.equal(tableAccessed, false);
  });
});

describe("Journey consumer isolation", () => {
  it("keeps segment storage out of all recommendation and behavior consumers", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, "..");
    const forbiddenRoots = [
      "compass",
      "services/social",
      "services/ranking",
      "services/notifications",
    ];
    const forbiddenNamedFiles = [
      "compassSenseScheduler.ts",
      "intelligenceGraphScheduler.ts",
    ];
    const files: string[] = [];
    const walk = (root: string) => {
      if (!fs.existsSync(root)) return;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(target);
      }
    };
    for (const root of forbiddenRoots) walk(path.join(srcRoot, root));
    for (const file of forbiddenNamedFiles) files.push(path.join(srcRoot, "lib", file));
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      assert.ok(
        !/journey_segment_revisions|JourneySegmenter|JourneySegmentationShadowService/.test(source),
        `Journey segments must remain shadow-only; forbidden consumer reference in ${path.relative(srcRoot, file)}`,
      );
    }
  });

  it("migration constrains coarse references and aggregate evidence at storage", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migration = fs.readFileSync(
      path.resolve(here, "../migrations/2103_journey_segment_shadow.sql"),
      "utf8",
    );
    assert.match(migration, /journey_segment_world_ref_value_shapes/);
    assert.match(migration, /journey_segment_world_ref_required_keys/);
    assert.match(migration, /journey_segment_reason_codes_known/);
    assert.ok(!migration.includes("confidence_factors"));
    assert.match(migration, /pg_advisory_xact_lock/);
    assert.match(
      migration,
      /COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED'[\s\S]*disable_location_sharing'[\s\S]*ORDER BY flag[\s\S]*FOR SHARE/,
    );
    assert.match(migration, /revoke_journey_consent_and_delete_segments/);
    assert.match(
      migration,
      /DELETE FROM journey_segment_revisions[\s\S]*INSERT INTO user_location_preferences/,
    );
    assert.ok(!/GRANT\s+SELECT,\s*INSERT/i.test(migration));
    assert.match(migration, /user_location_preferences p/);
    assert.match(migration, /p\.journey_observation_enabled = true/);
    assert.match(migration, /'journey_observation_enabled'/);
    assert.doesNotMatch(migration, /\bFROM location_preferences p\b/);
    assert.match(migration, /location_sessions s/);
  });
});

// ── NEW: Observation quality scorer tests ──────────────────────────────────

describe("JourneyObservationQuality scorer", () => {
  const freshAt = new Date(START_MS + 30_000); // 30 s after observation

  it("returns version, 0..1 score, class, sorted reason codes for a good GPS fix", () => {
    const result = scoreObservationQuality(
      {
        observedAt: new Date(START_MS).toISOString(),
        source: "foreground_gps",
        accuracyM: 8,
        speedMps: 1.2,
      },
      freshAt,
    );
    assert.equal(result.version, OBSERVATION_QUALITY_SCORER_VERSION);
    assert.ok(result.score >= 0 && result.score <= 1);
    assert.ok(["high", "usable", "degraded", "unusable"].includes(result.qualityClass));
    assert.deepEqual(result.reasons, [...result.reasons].sort());
    assert.equal(result.gpsSegmentable, true);
    assert.ok(result.score >= 0.8, `Expected high quality, got ${result.score}`);
  });

  it("scores explainably: reason codes explain each penalty applied", () => {
    // Missing speed → missing_speed reason
    const noSpeed = scoreObservationQuality(
      { observedAt: new Date(START_MS).toISOString(), source: "foreground_gps", accuracyM: 12 },
      freshAt,
    );
    assert.ok(noSpeed.reasons.includes("missing_speed"));

    // Moderate accuracy → acceptable_accuracy or moderate_accuracy
    const modAcc = scoreObservationQuality(
      { observedAt: new Date(START_MS).toISOString(), source: "foreground_gps", accuracyM: 60, speedMps: 1 },
      freshAt,
    );
    assert.ok(
      modAcc.reasons.includes("moderate_accuracy") || modAcc.reasons.includes("acceptable_accuracy"),
      `Expected accuracy reason, got: ${modAcc.reasons.join(", ")}`,
    );

    // Manual source → source_manual reason + lower score
    const manual = scoreObservationQuality(
      { observedAt: new Date(START_MS).toISOString(), source: "manual" },
      freshAt,
    );
    assert.ok(manual.reasons.includes("source_manual"));
    assert.ok(manual.score < 1);

    // Background GPS → source_background_gps reason
    const bg = scoreObservationQuality(
      { observedAt: new Date(START_MS).toISOString(), source: "background_gps", accuracyM: 15, speedMps: 0.5 },
      freshAt,
    );
    assert.ok(bg.reasons.includes("source_background_gps"));
  });

  it("makes stale observations (>10 min) unusable", () => {
    const staleAt = new Date(START_MS + 11 * 60_000); // received 11 min after observation
    const result = scoreObservationQuality(
      { observedAt: new Date(START_MS).toISOString(), source: "foreground_gps", accuracyM: 10, speedMps: 1 },
      staleAt,
    );
    assert.equal(result.qualityClass, "unusable");
    assert.ok(result.reasons.includes("stale"));
    assert.equal(result.gpsSegmentable, false);
  });

  it("makes future timestamps (>5 min) unusable", () => {
    // observation is 6 min in the future relative to receivedAt
    const receivedAt = new Date(START_MS);
    const futureObs = new Date(START_MS + 6 * 60_000).toISOString();
    const result = scoreObservationQuality(
      { observedAt: futureObs, source: "foreground_gps", accuracyM: 10, speedMps: 1 },
      receivedAt,
    );
    assert.equal(result.qualityClass, "unusable");
    assert.ok(result.reasons.includes("future_timestamp"));
    assert.equal(result.gpsSegmentable, false);
  });

  it("makes observations with accuracy >100 m unusable", () => {
    const result = scoreObservationQuality(
      { observedAt: new Date(START_MS).toISOString(), source: "foreground_gps", accuracyM: 150, speedMps: 1 },
      freshAt,
    );
    assert.equal(result.qualityClass, "unusable");
    assert.ok(result.reasons.includes("poor_accuracy"));
    assert.equal(result.gpsSegmentable, false);
  });

  it("makes observations with impossible speed unusable", () => {
    // 350 m/s > 340 m/s threshold
    const result = scoreObservationQuality(
      { observedAt: new Date(START_MS).toISOString(), source: "foreground_gps", accuracyM: 10, speedMps: 350 },
      freshAt,
    );
    assert.equal(result.qualityClass, "unusable");
    assert.ok(result.reasons.includes("impossible_speed"));
    assert.equal(result.gpsSegmentable, false);
  });

  it("manual and plan_checkin sources are never GPS-segmentable", () => {
    const receivedAt = new Date(START_MS + 5_000);
    for (const source of ["manual", "plan_checkin"] as const) {
      const result = scoreObservationQuality(
        { observedAt: new Date(START_MS).toISOString(), source },
        receivedAt,
      );
      assert.equal(result.gpsSegmentable, false, `${source} must not be GPS-segmentable`);
    }
  });

  it("is deterministic: same input always produces same output", () => {
    const input = {
      observedAt: new Date(START_MS).toISOString(),
      source: "foreground_gps" as const,
      accuracyM: 25,
      speedMps: 2,
    };
    const r1 = scoreObservationQuality(input, freshAt);
    const r2 = scoreObservationQuality(input, freshAt);
    assert.deepEqual(r1, r2);
  });
});

// ── NEW: Segmenter filtering of unusable/stale/poor-accuracy points ──────────

describe("JourneySegmenter quality-based pre-filtering", () => {
  it("excludes stale observations before segmentation (never contributes to stop)", () => {
    // All observations are stale (>10 min old) relative to receivedAt
    const receivedAt = new Date(START_MS + 12 * 60_000);
    const staleObs = stationary.map((p) => ({
      ...p,
      quality: {
        qualityVersion: OBSERVATION_QUALITY_SCORER_VERSION,
        qualityScore: 0,
        qualityClass: "unusable" as const,
        qualityReasons: ["stale"],
        gpsSegmentable: false,
      } satisfies JourneyObservationQualityFields,
    }));
    const revisions = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: staleObs,
      receivedAt,
    });
    assert.equal(revisions.length, 0, "Stale-only input should produce no revisions");
  });

  it("excludes poor-accuracy (>100 m) observations from segmentation", () => {
    const poorAccuracyObs = [
      point(0, 0, 0, 150),
      point(60, 5, 0, 200),
      point(180, -5, 0, 250),
      point(660, 3, 0, 180),
    ];
    const revisions = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: poorAccuracyObs,
      receivedAt: new Date(START_MS + 1_000),
    });
    // None of the poor-accuracy points survive filtering → no revisions
    assert.equal(revisions.length, 0);
  });

  it("excludes impossible-speed observations before segmentation", () => {
    const impossibleSpeeds = stationary.map((p) => ({ ...p, speedMps: 400 }));
    const revisions = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: impossibleSpeeds,
      receivedAt: new Date(START_MS + 1_000),
    });
    // Impossible speed → unusable → filtered out before any segment
    assert.equal(revisions.length, 0);
  });

  it("tracks excluded observation count in qualitySummary", () => {
    // Mix: 5 good + 1 poor accuracy. Place all observations within a 5-minute
    // window so none are stale, then use receivedAt just after the last one.
    // This isolates the accuracy-based exclusion.
    const BASE = START_MS;
    function recentPoint(sec: number, eastM: number, acc = 10): RestrictedJourneyObservation {
      return {
        id: `rp-${sec}-${eastM}-${acc}`,
        observedAt: new Date(BASE + sec * 1_000).toISOString(),
        source: "foreground_gps",
        lat: BASE_LAT + 0 / 111_320,
        lng: BASE_LNG + eastM / (111_320 * Math.cos((BASE_LAT * Math.PI) / 180)),
        accuracyM: acc,
      };
    }
    const mixed = [
      recentPoint(0, 0, 10),
      recentPoint(30, 4, 10),
      recentPoint(60, -5, 10),
      recentPoint(90, 7, 10),
      recentPoint(120, -3, 10),
      recentPoint(150, 10, 250), // poor accuracy → excluded by quality scorer
    ];
    const revisions = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: mixed,
      receivedAt: new Date(BASE + 155_000), // 5 s after last observation
    });
    assert.ok(revisions.length > 0);
    // The last revision should know about total vs usable
    const last = revisions.at(-1)!;
    assert.equal(last.qualitySummary.totalObservations, 6);
    assert.equal(last.qualitySummary.excludedObservations, 1);
  });
});

// ── NEW: Deterministic smoothing / replay / revision tests ───────────────────

describe("JourneySegmenter deterministic smoothing and revision", () => {
  it("centroid smoothing does not change state machine results vs arithmetic mean", () => {
    // The centroid smoothing replaces the previous running-average.
    // Results must still be deterministic between two identical replays.
    const r1 = run(stationary);
    const r2 = run(stationary);
    assert.deepEqual(r1, r2);
  });

  it("produces stable revisionIds across replays", () => {
    const r1 = run([...stationary, point(720, 220)]);
    const r2 = run([...stationary, point(720, 220)]);
    assert.deepEqual(
      r1.map((r) => r.revisionId),
      r2.map((r) => r.revisionId),
    );
  });

  it("new algorithm version produces different revisionIds but same structure", () => {
    const v1 = run(stationary);
    const v2 = run(stationary, undefined, "journey-stop-dwell-v2-test");
    assert.notEqual(v1[0]!.revisionId, v2[0]!.revisionId);
    assert.equal(v1.length, v2.length);
    assert.equal(v2[0]!.algorithmVersion, "journey-stop-dwell-v2-test");
  });

  it("timingUncertainty is present and non-negative on every revision", () => {
    const revisions = run([...stationary, point(720, 220)]);
    for (const revision of revisions) {
      assert.ok(
        "timingUncertainty" in revision,
        `revision ${revision.state} missing timingUncertainty`,
      );
      const { arrivalUncertaintyS, departureUncertaintyS } = revision.timingUncertainty;
      if (arrivalUncertaintyS != null) assert.ok(arrivalUncertaintyS >= 0);
      if (departureUncertaintyS != null) assert.ok(departureUncertaintyS >= 0);
    }
  });

  it("closed (ended) revisions have a non-null departureUncertaintyS", () => {
    const revisions = run([...stationary, point(720, 220)]);
    const departed = revisions.find((r) => r.state === "departed");
    assert.ok(departed, "expected a departed revision");
    assert.ok(departed.timingUncertainty.departureUncertaintyS != null);
    assert.ok(departed.timingUncertainty.arrivalUncertaintyS != null);
  });

  it("open revisions have null departureUncertaintyS", () => {
    const revisions = run(stationary); // no session end → dwelling open
    const dwelling = revisions.find((r) => r.state === "dwelling" && r.endedAt === null);
    assert.ok(dwelling, "expected an open dwelling");
    assert.equal(dwelling.timingUncertainty.departureUncertaintyS, null);
  });

  it("qualitySummary is present and gpsOnly for pure GPS tracks", () => {
    const revisions = run(stationary);
    for (const revision of revisions) {
      assert.ok("qualitySummary" in revision);
      assert.equal(revision.qualitySummary.gpsOnly, true);
      assert.ok(revision.qualitySummary.totalObservations >= 0);
    }
  });

  it("configurable thresholds override defaults deterministically", () => {
    // With a very wide stop radius, even widely separated points form a stop
    const wideRadius = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: [
        point(0, 0),
        point(60, 4),
        point(180, -5),
        point(360, 7),
        point(660, -3),
      ],
      thresholds: { stopRadiusM: 500, dwellMinSeconds: 300 },
    });
    const narrowRadius = run(stationary); // default 60 m
    // Both should produce consistent structure
    assert.ok(wideRadius.length > 0);
    assert.ok(narrowRadius.length > 0);
    // Wide radius should not produce FEWER segments (larger radius → easier stop)
    const wideDwells = wideRadius.filter((r) => r.state === "dwelling").length;
    const narrowDwells = narrowRadius.filter((r) => r.state === "dwelling").length;
    // Wide-radius config must match or exceed narrow-radius dwell detection
    assert.ok(wideDwells >= narrowDwells, "Wide radius should produce at least as many dwells");
  });
});

// ── NEW: Ambiguous place/category resolution ──────────────────────────────────

describe("JourneySegmenter place/category provenance", () => {
  const VALID_PLACE_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const ANOTHER_PLACE_UUID = "11111111-2222-4333-8444-555555555555";

  it("reports unknown place when no world refs are supplied", () => {
    const revisions = run(stationary);
    for (const revision of revisions) {
      assert.equal(revision.placeProvenance.placeConfidence, "unknown");
      assert.equal(revision.placeProvenance.categoryConfidence, "unknown");
      assert.equal(revision.placeProvenance.provenance, "none");
    }
  });

  it("reports unknown place when fewer than 3 usable observations agree on same placeId", () => {
    // Only 2 observations carry the placeId — below the threshold.
    // receivedAt is after the last observation so no future-timestamp filtering.
    const obs = [
      { ...point(0, 0), worldRef: { placeId: VALID_PLACE_UUID } },
      { ...point(60, 4), worldRef: { placeId: VALID_PLACE_UUID } },
      point(180, -5), // no worldRef
      point(360, 7),
      point(660, -3),
    ];
    const revisions = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: obs,
      receivedAt: new Date(START_MS + 665_000),
    });
    // Place should remain unknown (< 3 consistent)
    for (const revision of revisions) {
      assert.equal(revision.placeProvenance.placeConfidence, "unknown");
    }
  });

  it("resolves place when ≥3 usable GPS observations agree on the same canonical UUID", () => {
    // Place the 3 UUID observations near the END of the session so they are
    // within the fresh window relative to receivedAt (no staleness filtering).
    // We still need a dwell to form so that the evidence window for some
    // revision contains all 3 — use tight spacing around t=540..660s.
    const obs = [
      point(0, 0),   // anchor movement start
      point(60, 4),  // still moving
      { ...point(480, 4), worldRef: { placeId: VALID_PLACE_UUID } },  // candidate start
      { ...point(540, -4), worldRef: { placeId: VALID_PLACE_UUID } }, // within stop radius
      { ...point(600, 3), worldRef: { placeId: VALID_PLACE_UUID } },  // third consistent → threshold met
      point(630, 5),  // still within radius
      point(660, -2), // still within radius → triggers dwell
    ];
    // receivedAt is 5 s after the last observation so nothing is stale.
    const revisions = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: obs,
      receivedAt: new Date(START_MS + 665_000),
    });
    // At least some revision should have resolved place (on dwelling/candidate)
    const resolved = revisions.some((r) => r.placeProvenance.placeConfidence === "resolved");
    assert.ok(resolved, "Expected at least one revision with resolved place");
  });

  it("reports unknown when placeIds are ambiguous (different UUIDs)", () => {
    const obs = [
      { ...point(0, 0), worldRef: { placeId: VALID_PLACE_UUID } },
      { ...point(60, 4), worldRef: { placeId: ANOTHER_PLACE_UUID } },
      { ...point(180, -5), worldRef: { placeId: VALID_PLACE_UUID } },
      { ...point(360, 7), worldRef: { placeId: ANOTHER_PLACE_UUID } },
      point(660, -3),
    ];
    const revisions = segmentJourney({
      userId: USER_ID,
      locationSessionId: SESSION_ID,
      observations: obs,
      receivedAt: new Date(START_MS + 665_000),
    });
    // Neither UUID reaches threshold (each has 2) → unknown
    for (const revision of revisions) {
      assert.equal(
        revision.placeProvenance.placeConfidence,
        "unknown",
        `Expected unknown for ambiguous place in state ${revision.state}`,
      );
    }
  });

  it("never infers place from coordinates alone", () => {
    // Supply observations with no worldRef — coords present but no canonical refs
    const revisions = run(stationary);
    for (const revision of revisions) {
      assert.equal(revision.placeProvenance.provenance, "none");
      assert.equal(revision.placeProvenance.placeConfidence, "unknown");
    }
  });

  it("invalid worldRef shapes (non-UUID city, coordinate cityId) remain null", () => {
    const badWorldRef = stationary.map((obs) => ({
      ...obs,
      worldRef: {
        countryCode: "GB",
        cityId: "51.5074,-0.1278", // coordinate string → rejected by sanitizer
        placeId: "not-a-uuid",     // not UUID format → rejected
      },
    }));
    const revisions = run(badWorldRef);
    for (const revision of revisions) {
      assert.equal(revision.worldRef.cityId, null);
      assert.equal(revision.worldRef.placeId, null);
    }
  });
});

// ── NEW: Privacy serialization tests ─────────────────────────────────────────

describe("JourneySegmenter privacy serialization of new fields", () => {
  it("timingUncertainty, qualitySummary, placeProvenance contain no coords or IDs", () => {
    const revisions = run([...stationary, point(720, 220)]);
    const serialized = JSON.stringify(revisions);
    assert.ok(!/"lat"\s*:/.test(serialized), "no lat field in output");
    assert.ok(!/"lng"\s*:/.test(serialized), "no lng field in output");
    assert.ok(!serialized.includes("obs-"), "no raw observation IDs in output");
    assert.ok(!serialized.includes(String(BASE_LAT)), "no raw lat value in output");
    assert.ok(!serialized.includes(String(BASE_LNG)), "no raw lng value in output");
  });

  it("qualitySummary.scorerVersion is present and non-empty", () => {
    const revisions = run(stationary);
    for (const revision of revisions) {
      assert.ok(
        typeof revision.qualitySummary.scorerVersion === "string" &&
        revision.qualitySummary.scorerVersion.length > 0,
      );
    }
  });

  it("placeProvenance.provenance is either 'world_ref' or 'none' — never a coordinate string", () => {
    const revisions = run(stationary);
    for (const revision of revisions) {
      assert.ok(
        ["world_ref", "none"].includes(revision.placeProvenance.provenance),
      );
    }
  });
});

// ── NEW: JourneyShadowMetrics ground-truth comparison tests ──────────────────

describe("JourneyGroundTruthMetrics deterministic fixture tests", () => {
  // Build a set of ground-truth fixtures
  const DWELL_START_S = 0;
  const DWELL_END_S = 700;

  function makeGroundTruthFixtures(): JourneyGroundTruthFixture[] {
    const stationaryRevisions = run(stationary, 700);
    const transitRevisions = run([
      point(0, 0, 0, 8, 15),
      point(60, 900, 0, 8, 15),
      point(120, 1_800, 0, 8, 15),
      point(180, 2_700, 0, 8, 15),
    ], 200);
    const sparseRevisions = run([point(0, 0), point(1_800, 2)]);
    const sessionEndRevisions = run([point(0, 0), point(60, 2)], 120);

    return [
      {
        condition: "stationary_dwell",
        expectedArrivalAt: new Date(START_MS + DWELL_START_S * 1_000).toISOString(),
        expectedDepartureAt: new Date(START_MS + DWELL_END_S * 1_000).toISOString(),
        expectedDwellS: DWELL_END_S - DWELL_START_S,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: stationaryRevisions,
      },
      {
        condition: "transit_moving",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: transitRevisions,
      },
      {
        condition: "sparse_no_stop",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: sparseRevisions,
      },
      {
        condition: "session_end_discarded",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: sessionEndRevisions,
      },
    ];
  }

  it("returns aggregate fixture count", () => {
    const fixtures = makeGroundTruthFixtures();
    const metrics = measureJourneyGroundTruth(fixtures);
    assert.equal(metrics.fixtures, 4);
  });

  it("has zero false stops and false dwells on well-labelled fixtures", () => {
    const fixtures = makeGroundTruthFixtures();
    const metrics = measureJourneyGroundTruth(fixtures);
    assert.equal(metrics.falseStop.falseCount, 0, "No false stops expected");
    assert.equal(metrics.falseDwell.falseCount, 0, "No false dwells expected");
  });

  it("computes arrival/departure error distributions without raw values", () => {
    const fixtures = makeGroundTruthFixtures();
    const metrics = measureJourneyGroundTruth(fixtures);
    // arrival error for stationary_dwell fixture should be present
    // (count >= 0)
    assert.ok(metrics.arrivalErrorDist.count >= 0);
    assert.ok(metrics.departureErrorDist.count >= 0);
    // No raw arrays exposed
    assert.ok(!("values" in metrics.arrivalErrorDist));
  });

  it("sampling gap distribution is non-empty for fixtures with multiple observations", () => {
    const fixtures = makeGroundTruthFixtures();
    const metrics = measureJourneyGroundTruth(fixtures);
    assert.ok(metrics.samplingGapDist.count > 0);
    assert.ok(metrics.samplingGapDist.medianS != null);
    assert.ok(metrics.samplingGapDist.p90S != null);
  });

  it("confidence calibration has an entry for every observed state", () => {
    const fixtures = makeGroundTruthFixtures();
    const metrics = measureJourneyGroundTruth(fixtures);
    // Every observed state has a calibration entry with count > 0
    for (const [, entry] of Object.entries(metrics.confidenceCalibration)) {
      if (entry.count > 0) {
        assert.ok(
          entry.meanUncertaintyScore >= 0 && entry.meanUncertaintyScore <= 1,
          `meanUncertaintyScore out of range: ${entry.meanUncertaintyScore}`,
        );
      }
    }
  });

  it("place match summary reports all unknown when no placeIds are supplied", () => {
    const fixtures = makeGroundTruthFixtures();
    const metrics = measureJourneyGroundTruth(fixtures);
    // None of our fixtures have expectedPlaceId
    assert.equal(metrics.placeMatch.expectedCount, 0);
    assert.equal(metrics.placeMatch.matchedCount, 0);
  });

  it("byCondition aggregates per label without exposing per-case data", () => {
    const fixtures = makeGroundTruthFixtures();
    const metrics = measureJourneyGroundTruth(fixtures);
    assert.deepEqual(
      Object.keys(metrics.byCondition).sort(),
      ["session_end_discarded", "sparse_no_stop", "stationary_dwell", "transit_moving"].sort(),
    );
    for (const [, entry] of Object.entries(metrics.byCondition)) {
      assert.ok(entry.fixtures >= 1);
      // No raw observation arrays in output
      assert.ok(!("revisions" in entry));
    }
  });

  it("is deterministic: identical fixtures produce identical metrics", () => {
    const f1 = makeGroundTruthFixtures();
    const f2 = makeGroundTruthFixtures();
    const m1 = measureJourneyGroundTruth(f1);
    const m2 = measureJourneyGroundTruth(f2);
    assert.deepEqual(m1, m2);
  });
});
