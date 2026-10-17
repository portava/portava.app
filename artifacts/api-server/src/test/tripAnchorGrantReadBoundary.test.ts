import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { canSeePlanItemLocation } from "../domain/trips/policies/privateAnchorAccess.js";
import { ANCHOR_SHARING_FLAG, planItemAccessFor, readAnchorGrantsForViewer } from "../server/trips/privateAnchorShares.js";
import { clientFor, fixture, itemId, json, plan, NOW, OTHER, TODAY, TOMORROW, TRIP, VIEWER,
  type Override, type Row, type Store } from "./helpers/tripCompassDayCountFixture.js";

const ANCHOR = itemId(500);
const SECRET = "ANCHOR-BOUNDARY-SECRET";
const VALID_GRANT = { plan_item_id: ANCHOR, owner_id: OTHER };

function grant(overrides: Row = {}): Row {
  return { ...VALID_GRANT, trip_id: TRIP, member_id: VIEWER, ...overrides };
}

function sharedFixture(): Store {
  const store = fixture();
  store.feature_flags.push({ flag: ANCHOR_SHARING_FLAG, enabled: true });
  store.trip_plan_items = [plan(), plan(500, {
    title: SECRET, day_date: TODAY, location_is_private: true, starts_at: `${TODAY}T11:00:00Z`,
  })];
  return store;
}

function todayGrantResponse(value: unknown): Override {
  let readingToday = false;
  return (url) => {
    if (url.pathname.endsWith("/trip_plan_items")) {
      if (url.searchParams.get("day_date") === `eq.${TODAY}`
        && url.searchParams.get("order") === "starts_at.asc,sort_order.asc"
        && url.searchParams.get("limit") === "5") readingToday = true;
      if (url.searchParams.get("day_date") === `eq.${TOMORROW}`) readingToday = false;
    }
    return readingToday && url.pathname.endsWith("/trip_private_anchor_shares") ? json(value) : undefined;
  };
}

describe("public anchor grant loaders validate the entire SDK payload", () => {
  const malformed: Array<[string, unknown]> = [
    ["null list", null], ["object list", {}], ["array-like object", { length: 0 }],
    ["string list", ""], ["number list", 0], ["boolean list", false],
    ["null row", [null]], ["array row", [[ANCHOR, OTHER]]],
    ["string row", [ANCHOR]], ["number row", [0]], ["boolean row", [false]],
  ];
  for (const field of ["plan_item_id", "owner_id"]) {
    for (const [label, value] of [
      ["missing", undefined], ["null", null], ["empty array", []],
      ["coercible array", [field === "plan_item_id" ? ANCHOR : OTHER]],
      ["object", {}], ["number", 0], ["boolean", false], ["empty", ""],
      ["whitespace", ` ${OTHER} `], ["non-UUID", "not-an-id"],
      ["noncanonical uppercase", "AAAAAAAA-0000-4000-8000-000000000001"],
    ] as const) malformed.push([`${field} ${label}`, [{ ...VALID_GRANT, [field]: value }]]);
  }
  malformed.push(
    ["valid prefix and invalid tail", [VALID_GRANT, { plan_item_id: itemId(501), owner_id: [OTHER] }]],
    ["invalid prefix and valid tail", [{ plan_item_id: null, owner_id: OTHER }, VALID_GRANT]],
    ["valid prefix and null tail", [VALID_GRANT, null]],
  );

  for (const [label, payload] of malformed) {
    it(`rejects ${label} before reading membership or granting any prefix`, async () => {
      for (const loader of [planItemAccessFor, readAnchorGrantsForViewer]) {
        const { client, requests } = clientFor(sharedFixture(), (url) =>
          url.pathname.endsWith("/trip_private_anchor_shares") ? json(payload) : undefined);
        const access = await loader(client, TRIP, VIEWER);
        assert.equal(access.status, "unread", loader.name);
        if ("grants" in access) assert.equal(access.grants.size, 0);
        assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/trip_members") || url.pathname.endsWith("/trips")));
        const reads = requests.filter(({ url }) => url.pathname.endsWith("/trip_private_anchor_shares"));
        assert.equal(reads.length, 1);
        assert.equal(reads[0]!.url.searchParams.get("select"), "plan_item_id,owner_id");
        assert.equal(reads[0]!.url.searchParams.get("trip_id"), `eq.${TRIP}`);
        assert.equal(reads[0]!.url.searchParams.get("member_id"), `eq.${VIEWER}`);
        assert.ok(requests.every(({ method }) => method === "GET"));
      }
    });
  }

  it("preserves canonical scalar grants through both public loaders", async () => {
    const store = sharedFixture();
    store.trip_private_anchor_shares = [grant(), grant({ plan_item_id: "aaaaaaaa-0000-0000-0000-000000000000" })];
    const { client } = clientFor(store);
    const access = await planItemAccessFor(client, TRIP, VIEWER);
    assert.equal(access.status, "ok");
    assert.deepEqual([...access.grants], [[ANCHOR, OTHER], ["aaaaaaaa-0000-0000-0000-000000000000", OTHER]]);
    const publicRead = await readAnchorGrantsForViewer(client, TRIP, VIEWER);
    assert.equal(publicRead.status, "ok");
    if (publicRead.status === "ok") assert.deepEqual([...publicRead.grantedToViewer], [ANCHOR, "aaaaaaaa-0000-0000-0000-000000000000"]);
  });

  it("keeps genuine empty grants readable without a membership read", async () => {
    const { client, requests } = clientFor(sharedFixture());
    const access = await planItemAccessFor(client, TRIP, VIEWER);
    assert.equal(access.status, "ok");
    assert.equal(access.grants.size, 0);
    assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/trip_members") || url.pathname.endsWith("/trips")));
  });

  it("does not introduce a duplicate-row policy for identical grants", async () => {
    const { client } = clientFor(sharedFixture(), (url) => url.pathname.endsWith("/trip_private_anchor_shares")
      ? json([VALID_GRANT, VALID_GRANT]) : undefined);
    const access = await planItemAccessFor(client, TRIP, VIEWER);
    assert.equal(access.status, "ok");
    assert.deepEqual([...access.grants], [[ANCHOR, OTHER]]);
  });

  for (const state of ["off", "absent"]) {
    it(`does not query grants while the sharing flag is ${state}`, async () => {
      const store = fixture();
      if (state === "off") store.feature_flags.push({ flag: ANCHOR_SHARING_FLAG, enabled: false });
      const { client, requests } = clientFor(store, (url) => url.pathname.endsWith("/trip_private_anchor_shares") ? json(null) : undefined);
      const access = await planItemAccessFor(client, TRIP, VIEWER);
      assert.equal(access.status, "ok");
      assert.equal(access.grants.size, 0);
      assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/trip_private_anchor_shares")));
    });
  }

  for (const error of [
    { code: "42P01", message: "missing table" }, { code: "PGRST205", message: "missing table" },
    { message: 'relation "trip_private_anchor_shares" does not exist' },
    { message: "Could not find the table 'trip_private_anchor_shares' in the schema cache" },
  ]) {
    it(`keeps known absent-table behavior for ${error.code ?? error.message}`, async () => {
      const { client, requests } = clientFor(sharedFixture(), (url) => url.pathname.endsWith("/trip_private_anchor_shares") ? json(error, 400) : undefined);
      const access = await planItemAccessFor(client, TRIP, VIEWER);
      assert.equal(access.status, "ok");
      assert.equal(access.grants.size, 0);
      assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/trip_members")));
    });
  }

  for (const code of ["42703", "PGRST204", "42501", "XX000"]) {
    it(`keeps ${code} unread rather than treating it as an absent table`, async () => {
      const { client } = clientFor(sharedFixture(), (url) => url.pathname.endsWith("/trip_private_anchor_shares")
        ? json({ code, message: 'relation "trip_private_anchor_shares" does not exist' }, 400) : undefined);
      assert.equal((await readAnchorGrantsForViewer(client, TRIP, VIEWER)).status, "unread");
    });
  }

  it("keeps SDK transport failure unread", async () => {
    const { client } = clientFor(sharedFixture(), (url) => {
      if (url.pathname.endsWith("/trip_private_anchor_shares")) throw Object.assign(new Error("synthetic abort"), { name: "AbortError" });
      return undefined;
    });
    assert.equal((await readAnchorGrantsForViewer(client, TRIP, VIEWER)).status, "unread");
  });

  it("keeps unread sharing flags unread without consulting grants", async () => {
    const { client, requests } = clientFor(sharedFixture(), (url) => url.pathname.endsWith("/feature_flags")
      && url.searchParams.get("flag") === `eq.${ANCHOR_SHARING_FLAG}` ? json({ code: "XX000", message: "unread" }, 400) : undefined);
    assert.equal((await planItemAccessFor(client, TRIP, VIEWER)).status, "unread");
    assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/trip_private_anchor_shares")));
  });

  for (const state of ["departed owner", "departed viewer", "owner fallback", "legacy unset status"]) {
    it(`preserves accepted-membership behavior: ${state}`, async () => {
      const store = sharedFixture();
      store.trip_private_anchor_shares = [grant()];
      if (state === "departed owner") store.trip_members.find((row) => row.user_id === OTHER)!.status = "left";
      if (state === "departed viewer") store.trip_members.find((row) => row.user_id === VIEWER)!.status = "left";
      if (state === "owner fallback") store.trip_members = store.trip_members.filter((row) => row.user_id !== VIEWER);
      if (state === "legacy unset status") for (const row of store.trip_members) delete row.status;
      const { client } = clientFor(store);
      const access = await planItemAccessFor(client, TRIP, VIEWER);
      assert.equal(access.status, "ok");
      assert.equal(access.grants.has(ANCHOR), !state.startsWith("departed"));
    });
  }

  it("retains creator-match permission checks after a structurally valid grant", async () => {
    const store = sharedFixture();
    store.trip_private_anchor_shares = [grant({ owner_id: VIEWER })];
    const { client } = clientFor(store);
    const access = await planItemAccessFor(client, TRIP, VIEWER);
    assert.equal(access.status, "ok");
    assert.equal(canSeePlanItemLocation(access, store.trip_plan_items[1]!), false);
  });

  it("preserves valid selected audience while malformed anchor grants are unread", async () => {
    const store = sharedFixture();
    store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
    store.trip_plan_item_audience = [{ trip_id: TRIP, plan_item_id: ANCHOR, member_id: VIEWER }];
    const { client } = clientFor(store, (url) => url.pathname.endsWith("/trip_private_anchor_shares") ? json(null) : undefined);
    const access = await planItemAccessFor(client, TRIP, VIEWER);
    assert.equal(access.status, "unread");
    assert.equal(access.grants.size, 0);
    assert.equal(access.selected?.has(ANCHOR), true);
    assert.equal(access.selectionUnread, undefined);
  });

  it("preserves valid anchor grants when selected-audience reads are unread", async () => {
    const store = sharedFixture();
    store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
    store.trip_private_anchor_shares = [grant()];
    const { client } = clientFor(store, (url) => url.pathname.endsWith("/trip_plan_item_audience") ? json(null) : undefined);
    const access = await planItemAccessFor(client, TRIP, VIEWER);
    assert.equal(access.status, "ok");
    assert.equal(access.grants.get(ANCHOR), OTHER);
    assert.equal(access.selected?.size, 0);
    assert.ok(access.selectionUnread);
  });

  it("keeps selected audience independent of the disabled anchor-sharing flag", async () => {
    const store = fixture();
    store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
    store.trip_plan_item_audience = [{ trip_id: TRIP, plan_item_id: ANCHOR, member_id: VIEWER }];
    const { client, requests } = clientFor(store);
    const access = await planItemAccessFor(client, TRIP, VIEWER);
    assert.equal(access.status, "ok");
    assert.equal(access.selected?.has(ANCHOR), true);
    assert.equal(access.grants.size, 0);
    assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/trip_private_anchor_shares")));
  });
});

describe("anchor grant boundary through mounted TODAY", () => {
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
  });

  afterEach(() => {
    mock.timers.reset();
    _setTestOpenAI(null);
    _setTestClient(null, false);
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function ask(store = sharedFixture(), override?: Override): Promise<string> {
    const { client } = clientFor(store, override);
    _setTestClient(client, true);
    const prompts: string[] = [];
    _setTestOpenAI({ chat: { completions: { create: async (request: {
      max_completion_tokens?: number; messages?: Array<{ content?: unknown }>;
    }) => {
      if (request.max_completion_tokens === 256) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
      prompts.push((request.messages ?? []).map((message) => String(message.content ?? "")).join("\n"));
      return { choices: [{ message: { role: "assistant", content: JSON.stringify({ message: "Today's trip context.", payload: null, quickActions: [] }) } }] };
    } } } } as unknown as NonNullable<Parameters<typeof _setTestOpenAI>[0]>);
    const response = await fetch(`${base}/api/compass/ask`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ prompt: "What is planned for today?" }),
    });
    const body: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(prompts.length > 0, "the actual main model must receive context");
    return prompts.at(-1)!;
  }

  function assertUnknown(prompt: string): void {
    assert.match(prompt, /Active trip:/);
    assert.match(prompt, /Tomorrow: 1 planned item\(s\)\./);
    assert.match(prompt, /Today's plan could not be read — do not state whether anything is scheduled today\./);
    assert.doesNotMatch(prompt, /No plan items scheduled today\.|Today's plan:/);
    assert.ok(!prompt.includes(SECRET), "private anchor title must not reach the main model");
  }

  it("reports unknown instead of a known slot for null-success grants", async () => {
    assertUnknown(await ask(sharedFixture(), todayGrantResponse(null)));
  });

  it("never string-coerces array-valued grant IDs into private anchor access", async () => {
    const prompt = await ask(sharedFixture(), todayGrantResponse([{ plan_item_id: [ANCHOR], owner_id: [OTHER] }]));
    assert.ok(!prompt.includes(SECRET), "array-valued grant IDs disclose the private anchor title");
    assertUnknown(prompt);
  });

  for (const [label, payload] of [
    ["array-like object", { length: 0 }], ["scalar list", false], ["non-object row", [ANCHOR]],
    ["valid grant then invalid owner", [VALID_GRANT, { plan_item_id: itemId(501), owner_id: [OTHER] }]],
    ["invalid owner then valid grant", [{ plan_item_id: itemId(501), owner_id: [OTHER] }, VALID_GRANT]],
  ] as const) {
    it(`does not expose a partial TODAY claim for ${label}`, async () => {
      const store = sharedFixture();
      store.trip_plan_items.push(plan(501, { day_date: TODAY, creator_id: VIEWER, title: "VISIBLE-BOUNDARY-PREFIX" }));
      const prompt = await ask(store, todayGrantResponse(payload));
      assertUnknown(prompt);
      assert.ok(!prompt.includes("VISIBLE-BOUNDARY-PREFIX"));
    });
  }

  for (const mode of ["valid grant", "real empty", "sharing off", "table absent", "private scope", "selected and granted", "selected only", "anchor grant only"]) {
    it(`retains existing TODAY permissions: ${mode}`, async () => {
      const store = sharedFixture();
      store.trip_private_anchor_shares = mode === "real empty" || mode === "selected only" ? [] : [grant()];
      if (mode === "sharing off") store.feature_flags.find((row) => row.flag === ANCHOR_SHARING_FLAG)!.enabled = false;
      if (mode === "private scope") store.trip_plan_items[1]!.privacy_scope = "private";
      if (["selected and granted", "selected only", "anchor grant only"].includes(mode)) {
        store.trip_plan_items[1]!.privacy_scope = "selected_participants";
        store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
        store.trip_plan_item_audience = mode === "anchor grant only" ? [] : [{ trip_id: TRIP, plan_item_id: ANCHOR, member_id: VIEWER }];
      }
      const prompt = await ask(store, mode === "table absent" ? (url) => url.pathname.endsWith("/trip_private_anchor_shares")
        ? json({ code: "42P01", message: "missing table" }, 400) : undefined : undefined);
      assert.match(prompt, /Active trip:/);
      assert.match(prompt, /Tomorrow: 1 planned item\(s\)\./);
      assert.doesNotMatch(prompt, /Today's plan could not be read/);
      assert.equal(prompt.includes(SECRET), mode === "valid grant" || mode === "selected and granted");
      if (mode === "private scope" || mode === "anchor grant only") {
        assert.match(prompt, /No plan items scheduled today\./);
      } else if (mode !== "valid grant" && mode !== "selected and granted") {
        assert.match(prompt, /Today's plan: <portava:ugc>Private plan<\/portava:ugc> \(11:00\)/);
      }
    });
  }
});
