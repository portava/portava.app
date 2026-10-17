import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { buildTripWorldContext, formatTripWorldContextLines, TRIP_CREW_CAP } from "../compass/CompassTripContext.js";
import { readTripMetric } from "../domain/trips/services/tripMetrics.js";
import { stripComments } from "../scripts/lib/stripComments.js";
import { clientFor, fixture, json, VIEWER, OTHER, TRIP, FOREIGN_TRIP, NOW,
  type Override, type Row } from "./helpers/tripCompassDayCountFixture.js";

type Client = ReturnType<typeof clientFor>["client"];
type Requests = ReturnType<typeof clientFor>["requests"];
let server: Server;
let base: string;

before(async () => {
  const { default: router } = await import("../routes/compass.js");
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.assign(request, { log: { info() {}, error() {}, warn() {}, debug() {} } });
    next();
  });
  app.use("/api", router);
  server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  invalidateFlagsCache();
  _clearPromotedScopeCache();
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  _setTestClient(null, false);
  _setTestOpenAI(null);
  _clearPromotedScopeCache();
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function member(index: number, values: Row = {}): Row {
  return { trip_id: TRIP, user_id: index === 0 ? VIEWER : index === 1 ? OTHER : `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    role: index === 0 ? "owner" : "member", status: "accepted", profiles: { handle: `handle-${index}` }, ...values };
}

function isCrewRead(url: URL): boolean {
  return url.pathname.endsWith("/trip_members") && url.searchParams.get("select") === "profiles(handle),role,status";
}

function setup(rows = [member(0), member(1)], override?: Override, customize?: (client: Client) => void, live = false) {
  const store = fixture();
  store.trip_members = rows;
  store.trip_plan_items = [];
  if (live) store.compass_live_sessions = [{ id: "70000000-0000-4000-8000-000000000001", user_id: VIEWER, trip_id: TRIP,
    status: "active", ended_at: null, started_at: new Date(NOW).toISOString(), context: { city: "Cebu", recentEvents: [] } }];
  const { client, requests } = clientFor(store, (url) => {
    const replaced = override?.(url);
    if (replaced) return replaced;
    if (!isCrewRead(url)) return undefined;
    const selected = rows.filter((row) => `eq.${row.trip_id}` === url.searchParams.get("trip_id")
      && `eq.${row.status}` === url.searchParams.get("status")).slice(0, Number(url.searchParams.get("limit")));
    return json(selected.map((row) => ({ profiles: row.profiles == null ? row.profiles : { handle: (row.profiles as Row).handle },
      role: row.role, status: row.status })));
  });
  customize?.(client);
  return { client, requests };
}

function assertCrewQuery(requests: Requests, expectedReads = 1): void {
  const reads = requests.filter(({ url }) => isCrewRead(url));
  assert.equal(reads.length, expectedReads);
  for (const { url, method } of reads) {
    assert.equal(method, "GET");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      select: "profiles(handle),role,status", trip_id: `eq.${TRIP}`, status: "eq.accepted", limit: "8",
    });
  }
}

function throwCrew(client: Client): void {
  const from = client.from.bind(client);
  mock.method(client, "from", (table: string) => {
    const builder = from(table);
    if (table === "trip_members") {
      const select = builder.select.bind(builder);
      mock.method(builder, "select", (columns: string, options?: Parameters<typeof select>[1]) => {
        if (columns.includes("profiles(handle)")) throw new Error("synthetic crew method throw");
        return select(columns, options);
      });
    }
    return builder;
  });
}

async function world(rows?: Row[], override?: Override, customize?: (client: Client) => void) {
  const { client, requests } = setup(rows, override, customize);
  const context = await buildTripWorldContext(client, VIEWER, { now: new Date(NOW), opportunities: [] });
  assert.ok(requests.every(({ method }) => method === "GET"));
  return { context, lines: formatTripWorldContextLines(context).join("\n"), requests };
}

async function ask(rows?: Row[], override?: Override, customize?: (client: Client) => void, live = false) {
  const { client, requests } = setup(rows, override, customize, live);
  _setTestClient(client, true);
  const prompts: string[] = [];
  _setTestOpenAI({ chat: { completions: { create: async (request: {
    max_completion_tokens?: number; messages?: Array<{ content?: unknown }>;
  }) => {
    if (request.max_completion_tokens === 256) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.95 }) } }] };
    prompts.push((request.messages ?? []).map((message) => String(message.content ?? "")).join("\n"));
    return { choices: [{ message: { role: "assistant", content: JSON.stringify({ message: "Crew context received.", payload: null, quickActions: [] }) } }] };
  } } } } as unknown as NonNullable<Parameters<typeof _setTestOpenAI>[0]>);
  const response = await fetch(`${base}/api/compass/ask`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token", connection: "close" },
    body: JSON.stringify({ prompt: "Who is on my trip today?" }), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.ok(prompts.length > 0);
  return { prompt: prompts.at(-1)!, requests };
}

describe("CT02 crew handles on the mounted main-model prompt path", () => {
  it("accepts the typed envelope before crew reaches the actual main-model request", async () => {
    const accepted = () => readTripMetric("projection_lag_seconds")
      .find((series) => series.labels.projection === "TripCompassCrewHandlesProjection")?.count ?? 0;
    const beforeCount = accepted();
    const { prompt, requests } = await ask();
    assertCrewQuery(requests);
    assert.match(prompt, /Crew: @handle-0, @handle-1/);
    assert.equal(accepted(), beforeCount + 1);
    const crewIndex = requests.findIndex(({ url }) => isCrewRead(url));
    assert.ok(crewIndex > 0);
    assert.equal(requests[crewIndex - 1]!.url.pathname, "/rest/v1/trips");
    assert.equal(requests[crewIndex - 1]!.url.searchParams.get("select"), "version");
    assert.equal(requests[crewIndex - 1]!.url.searchParams.get("id"), `eq.${TRIP}`);
  });

  it("leaves no raw trip, member or plan reads in CompassTripContext", () => {
    const source = stripComments(readFileSync(new URL("../compass/CompassTripContext.ts", import.meta.url), "utf8"));
    const reads = [...source.matchAll(/\.from\(\s*"(trips|trip_members|trip_plan_items)"\s*\)/g)].map((match) => match[1]);
    assert.deepEqual(reads, []);
  });

  it("preserves cap eight, transport order and self inclusion without a ninth row", async () => {
    assert.equal(TRIP_CREW_CAP, 8);
    const { prompt, requests } = await ask(Array.from({ length: 9 }, (_, index) => member(index)));
    assertCrewQuery(requests);
    assert.ok(prompt.includes(`Crew: ${Array.from({ length: 8 }, (_, index) => `@handle-${index}`).join(", ")}`));
    assert.doesNotMatch(prompt, /handle-8/);
  });

  it("caps raw rows before filtering empty or missing joined handles without refill", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => member(index, {
      profiles: index < 8 ? index % 2 === 0 ? null : { handle: "" } : { handle: "NINTH-REFILL-FORBIDDEN" },
    }));
    const { prompt, requests } = await ask(rows);
    assertCrewQuery(requests);
    assert.match(prompt, /Crew: travelling solo, or no accepted members/);
    assert.doesNotMatch(prompt, /NINTH-REFILL-FORBIDDEN/);
  });

  it("preserves accepted-only status and does not add a role filter", async () => {
    const rows = [member(0), member(1, { role: "viewer" }), member(2, { role: "co_host" }), member(3, { status: null }),
      member(4, { status: "invited" }), member(5, { status: "removed" }), member(6, { status: "left" }),
      member(7, { status: "declined" }), member(8, { trip_id: FOREIGN_TRIP })];
    const { context, requests } = await world(rows);
    assertCrewQuery(requests);
    assert.deepEqual(context.crew, ["@handle-0", "@handle-1", "@handle-2"]);
  });

  it("keeps nonempty strings, duplicates, whitespace and unconditional at-prefixing", async () => {
    const handles = ["repeat", "repeat", "@already", " padded ", null, "", 0, false];
    const { prompt, requests } = await ask(handles.map((handle, index) => member(index, { profiles: { handle } })));
    assertCrewQuery(requests);
    assert.match(prompt, /Crew: @repeat, @repeat, @@already, @ padded /);
  });

  it("does not synthesize an absent viewer row from owned-trip fallback", async () => {
    const { context, requests } = await world([member(1)]);
    assertCrewQuery(requests);
    assert.deepEqual(context.crew, ["@handle-1"]);
  });

  for (const value of [[], null]) {
    it(`preserves ${value === null ? "legacy null-success" : "empty-array"} wording without claiming a complete roster`, async () => {
      const { prompt, requests } = await ask(undefined, (url) => isCrewRead(url) ? json(value) : undefined);
      assertCrewQuery(requests);
      assert.match(prompt, /Crew: travelling solo, or no accepted members/);
      assert.doesNotMatch(prompt, /Crew: could not be read/);
    });
  }

  it("keeps returned errors partial and distinct from an empty crew", async () => {
    const { prompt, requests } = await ask(undefined, (url) => isCrewRead(url)
      ? json({ code: "XX000", message: "synthetic read failure" }, 400) : undefined);
    assertCrewQuery(requests);
    assert.match(prompt, /\[Trip world context\]/);
    assert.match(prompt, /Crew: could not be read/);
    assert.match(prompt, /Disruptions: none reported/);
    assert.match(prompt, /Experience sessions: none open/);
    assert.doesNotMatch(prompt, /Crew: travelling solo/);
  });

  it("keeps real SDK fetch rejection and its three retries on the returned-error partial path", async () => {
    const { prompt, requests } = await ask(undefined, (url) => {
      if (isCrewRead(url)) throw new Error("synthetic transport rejection");
      return undefined;
    });
    assertCrewQuery(requests, 4);
    assert.match(prompt, /Crew: could not be read/);
    assert.match(prompt, /Disruptions: none reported/);
  });

  it("keeps a genuine query-method throw total fail-soft while Live grounding survives", async () => {
    const { prompt } = await ask(undefined, undefined, throwCrew, true);
    assert.match(prompt, /Live session: ACTIVE/);
    assert.doesNotMatch(prompt, /\[Trip world context\]|Crew: could not be read/);
  });

  for (const value of [{ profiles: { handle: "not-a-row-array" } }, [null]]) {
    it(`preserves total fail-soft for legacy ${Array.isArray(value) ? "null row" : "object payload"} rather than widening validation policy`, async () => {
      const { context, lines, requests } = await world(undefined, (url) => isCrewRead(url) ? json(value) : undefined);
      assertCrewQuery(requests);
      assert.equal(context.tripId, null);
      assert.equal(lines, "");
      assert.deepEqual(context.unavailable, []);
    });
  }

  it("keeps readable crew in TripWorld when Live suppresses ordinary trip grounding", async () => {
    const { prompt, requests } = await ask(undefined, undefined, undefined, true);
    assertCrewQuery(requests);
    assert.match(prompt, /Live session: ACTIVE/);
    assert.match(prompt, /Crew: @handle-0, @handle-1/);
    assert.doesNotMatch(prompt, /\[Trip context\]/);
  });

  it("does not replace handle context with presence, location, blocks or a crew-map gate", async () => {
    const { context, requests } = await world();
    assert.deepEqual(context.crew, ["@handle-0", "@handle-1"]);
    const absent = ["trip_crew_location_preferences", "trip_crew_location_sessions", "user_location_state", "location_preferences",
      "safe_return_sessions", "blocks", "profiles"];
    assert.ok(!requests.some(({ url }) => absent.some((table) => url.pathname.endsWith(`/${table}`))));
    assert.ok(!requests.some(({ url }) => url.searchParams.get("flag") === "eq.trip_crew_map_enabled"));
  });

  it("keeps unread canonical version consumable as unattributable without a fallback crew read", async () => {
    const { prompt, requests } = await ask(undefined, (url) => url.pathname.endsWith("/trips") && url.searchParams.get("select") === "version"
      ? json({ code: "XX000", message: "version unread" }, 400) : undefined);
    assertCrewQuery(requests);
    assert.match(prompt, /Crew: @handle-0, @handle-1/);
  });

  it("refuses an invalid generatedAt through the existing envelope rule without a raw fallback", async () => {
    const { client, requests } = setup();
    const now = new Date(NOW);
    mock.method(now, "toISOString", () => "not-an-instant");
    const context = await buildTripWorldContext(client, VIEWER, { now });
    assertCrewQuery(requests);
    assert.equal(context.tripId, TRIP);
    assert.ok(context.unavailable.includes("crew"));
    assert.deepEqual(context.crew, []);
    assert.match(formatTripWorldContextLines(context).join("\n"), /Crew: could not be read/);
  });
});
