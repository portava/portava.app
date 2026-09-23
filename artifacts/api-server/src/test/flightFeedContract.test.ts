/**
 * Contract tests for the flight feed port — census-layover L169, and the
 * itinerary facts behind L283 (AIRPORT_CHANGE_REQUIRED) and L284
 * (SELF_TRANSFER_FRICTION).
 *
 * The properties under test are the ones that decide whether this adapter is
 * honest when it cannot answer, because that is the state every deployment is
 * in: no flight-data credential exists anywhere in this project. So the
 * assertions are weighted towards refusal shapes, and towards proving that no
 * failure path can produce an itinerary that a consumer would read as a fact
 * about a real flight.
 *
 * NO NETWORK. `fetchImpl` is injected everywhere. NO process.env MUTATION.
 * `readEnv` is injected, because `--test` runs every suite in one process.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NO_FLIGHT_FEED_PROVIDER,
  airportChangeRequired,
  aviationStackShape,
  canonDesignator,
  connectionMinutes,
  createHttpFlightItineraryProvider,
  itineraryIsStale,
  itineraryQueryRefusal,
  selfTransferFriction,
  type FlightItinerary,
  type FlightLeg,
  type ItineraryQuery,
} from "../lib/providers/flightItineraryProvider.js";

const Q: ItineraryQuery = { inboundDesignator: "BA286", onwardDesignator: "BA1442", date: "2030-06-01" };
const NOW = new Date("2030-06-01T12:00:00.000Z");
const CRED = "FLIGHT_FEED_API_KEY";

function leg(over: Partial<FlightLeg> = {}): FlightLeg {
  return {
    designator: "BA286",
    departureAirport: "SFO",
    arrivalAirport: "LHR",
    departureTerminal: null,
    arrivalTerminal: "5",
    scheduledDeparture: "2030-06-01T02:00:00.000Z",
    scheduledArrival: "2030-06-01T12:00:00.000Z",
    estimatedDeparture: null,
    estimatedArrival: null,
    status: "SCHEDULED",
    ...over,
  };
}

function itinerary(over: Partial<FlightItinerary> = {}): FlightItinerary {
  return {
    inbound: leg(),
    onward: leg({
      designator: "BA1442",
      departureAirport: "LHR",
      arrivalAirport: "EDI",
      scheduledDeparture: "2030-06-01T16:00:00.000Z",
      scheduledArrival: "2030-06-01T17:20:00.000Z",
    }),
    ticketing: "UNKNOWN",
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    sourceRefs: ["t"],
    ...over,
  };
}

// ── the resting state: refusal ───────────────────────────────────────────────

describe("L169 — with no feed, the port refuses and never invents an itinerary", () => {
  it("answers a named refusal", async () => {
    const r = await NO_FLIGHT_FEED_PROVIDER.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_UNBOUND");
    assert.equal("value" in r, false, "a refusal must carry no itinerary to be read");
  });

  it("is not marked live", () => {
    assert.equal(NO_FLIGHT_FEED_PROVIDER.live, false);
  });

  it("the refusal says the facts are refused rather than guessed from the trip row", async () => {
    const r = await NO_FLIGHT_FEED_PROVIDER.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.detail, /refused rather than guessed/);
  });
});

// ── L283 ─────────────────────────────────────────────────────────────────────

describe("L283 — AIRPORT_CHANGE_REQUIRED is about airports, not terminals", () => {
  it("true when the onward flight leaves from a different airport", () => {
    const it = itinerary({ onward: leg({ departureAirport: "LGW", arrivalAirport: "EDI" }) });
    assert.equal(airportChangeRequired(it), true);
  });

  it("false when the traveller stays at one airport", () => {
    assert.equal(airportChangeRequired(itinerary()), false);
  });

  it("a TERMINAL change within one airport is not an airport change", () => {
    // Conflating them would fire the warning on most large hubs, and a warning
    // that fires on most itineraries is ignored on the one where it matters.
    const it = itinerary({
      inbound: leg({ arrivalAirport: "LHR", arrivalTerminal: "5" }),
      onward: leg({ departureAirport: "LHR", departureTerminal: "3" }),
    });
    assert.equal(airportChangeRequired(it), false);
  });

  it("compares case-insensitively rather than treating lhr and LHR as a change", () => {
    const it = itinerary({
      inbound: leg({ arrivalAirport: "lhr" }),
      onward: leg({ departureAirport: "LHR" }),
    });
    assert.equal(airportChangeRequired(it), false);
  });
});

// ── L284 ─────────────────────────────────────────────────────────────────────

describe("L284 — SELF_TRANSFER_FRICTION has three answers, not two", () => {
  it("separate tickets is friction", () => {
    assert.equal(selfTransferFriction(itinerary({ ticketing: "SEPARATE_TICKETS" })), true);
  });

  it("a single ticket is not", () => {
    assert.equal(selfTransferFriction(itinerary({ ticketing: "SINGLE_TICKET" })), false);
  });

  it("UNKNOWN is null — NOT false, which would silently withhold the warning", () => {
    const r = selfTransferFriction(itinerary({ ticketing: "UNKNOWN" }));
    assert.equal(r, null);
    assert.notEqual(r, false, "an unknown ticketing arrangement is not a reassurance");
  });
});

// ── connection window ────────────────────────────────────────────────────────

describe("the connection window says which times it used", () => {
  it("uses scheduled times and says so when the feed states no estimate", () => {
    const r = connectionMinutes(itinerary())!;
    assert.equal(r.minutes, 240);
    assert.equal(r.basis, "SCHEDULED");
  });

  it("prefers the estimate and says so when both ends have one", () => {
    const it = itinerary({
      inbound: leg({ estimatedArrival: "2030-06-01T13:30:00.000Z" }),
      onward: leg({
        departureAirport: "LHR",
        scheduledDeparture: "2030-06-01T16:00:00.000Z",
        estimatedDeparture: "2030-06-01T16:10:00.000Z",
      }),
    });
    const r = connectionMinutes(it)!;
    assert.equal(r.minutes, 160, "a 90-minute delay eats the connection window");
    assert.equal(r.basis, "ESTIMATED");
  });

  it("reports MIXED when only one end is live — the caller can see the asymmetry", () => {
    const it = itinerary({ inbound: leg({ estimatedArrival: "2030-06-01T13:00:00.000Z" }) });
    assert.equal(connectionMinutes(it)!.basis, "MIXED");
  });

  it("returns null, NOT zero, when an instant cannot be read", () => {
    const it = itinerary({ inbound: leg({ scheduledArrival: "whenever", estimatedArrival: null }) });
    const r = connectionMinutes(it);
    assert.equal(r, null, "zero minutes between flights would read as a missed connection");
  });
});

// ── staleness ────────────────────────────────────────────────────────────────

describe("an itinerary carries its own expiry", () => {
  it("is fresh before and stale at its expiry", () => {
    const it = itinerary();
    const e = Date.parse(it.expiresAt);
    assert.equal(itineraryIsStale(it, e - 1), false);
    assert.equal(itineraryIsStale(it, e), true);
  });

  it("an unreadable expiry is STALE, not fresh", () => {
    assert.equal(itineraryIsStale(itinerary({ expiresAt: "soon" }), 0), true);
  });
});

// ── query validation ─────────────────────────────────────────────────────────

describe("query validation happens before anything is spent", () => {
  it("accepts a well-formed designator in several spellings", () => {
    assert.equal(canonDesignator("ba 286"), "BA286");
    assert.equal(canonDesignator("ba-286"), "BA286");
    assert.equal(itineraryQueryRefusal("p", Q), null);
    assert.equal(itineraryQueryRefusal("p", { ...Q, inboundDesignator: "ba 286" }), null);
  });

  it("accepts the carrier-code shapes that actually exist", () => {
    for (const good of ["BA286", "BAW286", "U21234", "9W123"]) {
      assert.equal(itineraryQueryRefusal("p", { ...Q, inboundDesignator: good }), null, good);
    }
  });

  it("refuses something that is not a designator", () => {
    // "286" is the case that caught a real bug: the first pattern read "28" as
    // a carrier code and "6" as the flight number, so a bare flight number with
    // no airline would have been sent upstream and spent a request.
    for (const bad of ["", "BA", "286", "1234", "NOTAFLIGHT123456", "B"]) {
      const r = itineraryQueryRefusal("p", { ...Q, inboundDesignator: bad });
      assert.notEqual(r, null, `"${bad}" should not pass as a designator`);
      assert.equal(r!.reason, "REQUEST_INCOMPLETE");
    }
  });

  it("refuses a date that is not YYYY-MM-DD", () => {
    for (const bad of ["", "01/06/2030", "2030-6-1"]) {
      assert.notEqual(itineraryQueryRefusal("p", { ...Q, date: bad }), null);
    }
  });
});

// ── the HTTP adapter ─────────────────────────────────────────────────────────

describe("the HTTP flight adapter — complete, and refusing for want of a credential", () => {
  const cfg = {
    id: "test-flight-feed",
    credentialEnv: CRED,
    url: (q: ItineraryQuery, key: string) =>
      `https://example.invalid/flights?flight_date=${q.date}&access_key=${encodeURIComponent(key)}`,
    mapper: aviationStackShape,
  };

  function neverFetch(): typeof fetch {
    return (async () => {
      assert.fail("the adapter made a request with no usable credential");
    }) as unknown as typeof fetch;
  }

  function respond(status: number, body: unknown, record?: string[]): typeof fetch {
    return (async (url: any) => {
      record?.push(String(url));
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const BODY = {
    data: [
      {
        flight: { iata: "BA286" },
        flight_status: "active",
        departure: { iata: "SFO", terminal: "I", scheduled: "2030-06-01T02:00:00+00:00", estimated: null },
        arrival: { iata: "LHR", terminal: "5", scheduled: "2030-06-01T12:00:00+00:00", estimated: "2030-06-01T12:25:00+00:00" },
      },
      {
        flight: { iata: "BA1442" },
        flight_status: "scheduled",
        departure: { iata: "LHR", terminal: "5", scheduled: "2030-06-01T16:00:00+00:00" },
        arrival: { iata: "EDI", scheduled: "2030-06-01T17:20:00+00:00" },
      },
    ],
  };

  it("refuses CREDENTIAL_ABSENT without ever calling out", async () => {
    const p = createHttpFlightItineraryProvider(cfg, { fetchImpl: neverFetch(), readEnv: () => undefined });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "CREDENTIAL_ABSENT");
    assert.equal(r.envVar, CRED);
  });

  it("distinguishes a credential set to an empty string", async () => {
    const p = createHttpFlightItineraryProvider(cfg, { fetchImpl: neverFetch(), readEnv: () => "" });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "CREDENTIAL_EMPTY");
  });

  it("validates the query before reaching the credential check", async () => {
    const p = createHttpFlightItineraryProvider(cfg, { fetchImpl: neverFetch(), readEnv: () => undefined });
    const r = await p.itinerary({ ...Q, date: "nope" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "REQUEST_INCOMPLETE");
  });

  it("maps a real response shape into two legs with the fields L283/L284 need", async () => {
    const p = createHttpFlightItineraryProvider(cfg, {
      fetchImpl: respond(200, BODY),
      readEnv: () => "a-key",
      now: () => NOW,
    });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const it = r.value;
    assert.equal(it.inbound.designator, "BA286");
    assert.equal(it.inbound.arrivalAirport, "LHR");
    assert.equal(it.inbound.arrivalTerminal, "5");
    assert.equal(it.inbound.status, "ACTIVE");
    assert.equal(it.inbound.estimatedArrival, "2030-06-01T12:25:00.000Z");
    assert.equal(it.onward.departureAirport, "LHR");
    assert.equal(airportChangeRequired(it), false);
    // The feed states no ticketing, so the friction question stays unanswered.
    assert.equal(selfTransferFriction(it), null);
    assert.equal(connectionMinutes(it)!.basis, "MIXED");
  });

  it("leaves estimated times NULL when the feed states none — never defaulted to scheduled", async () => {
    const p = createHttpFlightItineraryProvider(cfg, {
      fetchImpl: respond(200, BODY),
      readEnv: () => "a-key",
      now: () => NOW,
    });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(
      r.value.inbound.estimatedDeparture,
      null,
      "defaulting to the scheduled time turns 'we do not know if it is late' into 'it is on time'",
    );
    assert.equal(r.value.onward.estimatedDeparture, null);
  });

  it("an unrecognised status maps to UNKNOWN, never to SCHEDULED", () => {
    const body = {
      data: [
        { ...BODY.data[0], flight_status: "wibble" },
        BODY.data[1],
      ],
    };
    const m = aviationStackShape(body, { ...Q, inboundDesignator: "BA286", onwardDesignator: "BA1442" });
    assert.equal("error" in m, false);
    if ("error" in m) return;
    assert.equal(m.inbound.status, "UNKNOWN");
    assert.notEqual(m.inbound.status, "SCHEDULED");
  });

  it("a 200 with no matching flight is a refusal, not an itinerary with empty legs", async () => {
    const p = createHttpFlightItineraryProvider(cfg, {
      fetchImpl: respond(200, { data: [] }),
      readEnv: () => "a-key",
      now: () => NOW,
    });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_MALFORMED");
    assert.match(r.detail, /no readable record/);
  });

  it("a leg missing an airport or a time is not half-built from what is there", () => {
    const body = {
      data: [
        { flight: { iata: "BA286" }, departure: { iata: "SFO" }, arrival: { iata: "LHR", scheduled: "2030-06-01T12:00:00Z" } },
        BODY.data[1],
      ],
    };
    const m = aviationStackShape(body, Q);
    assert.equal("error" in m, true, "a leg with no scheduled departure is not a leg");
  });

  it("the ready-made mapper never claims a ticketing arrangement it cannot know", () => {
    const m = aviationStackShape(BODY, Q);
    assert.equal("error" in m, false);
    if ("error" in m) return;
    assert.equal(
      m.ticketing,
      "UNKNOWN",
      "a flight STATUS feed does not know how a ticket was sold; a shared carrier code is not one ticket",
    );
  });

  it("a body with no data array is MALFORMED", () => {
    assert.equal("error" in aviationStackShape({ ok: true }, Q), true);
    assert.equal("error" in aviationStackShape(null, Q), true);
  });

  it("401 is PROVIDER_REJECTED and names the credential variable", async () => {
    const p = createHttpFlightItineraryProvider(cfg, {
      fetchImpl: respond(401, {}),
      readEnv: () => "a-key",
      now: () => NOW,
    });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_REJECTED");
    assert.equal(r.envVar, CRED);
  });

  it("429 is distinguished from an outage", async () => {
    const p = createHttpFlightItineraryProvider(cfg, {
      fetchImpl: respond(429, {}),
      readEnv: () => "a-key",
      now: () => NOW,
    });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_REJECTED");
    assert.match(r.detail, /quota/);
  });

  it("a thrown fetch is a refusal, never an absent itinerary", async () => {
    const p = createHttpFlightItineraryProvider(cfg, {
      readEnv: () => "a-key",
      now: () => NOW,
      fetchImpl: (async () => {
        throw new TypeError("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    const r = await p.itinerary(Q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
  });

  it("canonicalises the designators before building the URL", async () => {
    const urls: string[] = [];
    const p = createHttpFlightItineraryProvider(
      { ...cfg, url: (q) => `https://example.invalid/${q.inboundDesignator}/${q.onwardDesignator}/${q.date}` },
      { fetchImpl: respond(200, BODY, urls), readEnv: () => "a-key", now: () => NOW },
    );
    await p.itinerary({ ...Q, inboundDesignator: "ba 286", onwardDesignator: "ba-1442" });
    assert.equal(urls[0], "https://example.invalid/BA286/BA1442/2030-06-01");
  });
});
