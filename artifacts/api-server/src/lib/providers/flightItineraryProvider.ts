/**
 * The FLIGHT FEED port — census-layover L169, and the inputs for L283/L284.
 *
 * ── WHAT L169 ASKS FOR, AND WHY IT IS BLOCKED ON A FEED ──────────────────────
 * L169 is `LayoverSessionService.detectFromTrip(userId, tripId)`. The census
 * records the state and the reason:
 *
 *   > Nothing detects a connection. The trip screen shows a manual banner that
 *   > opens the creation sheet.
 *   > (§) "Nothing detects a connection. A traveller telling us their flight
 *   > moved is not detection."
 *
 * DETECTING a connection means answering questions about real flights that no
 * table in this repository holds: does this designator on this date actually
 * arrive at this airport, when, at which terminal, and does the traveller's
 * next flight leave from there. A trip row carries what a traveller typed. The
 * gap is a feed, and there is none: a grep across this repository finds no
 * flight-schedule or flight-status credential of any kind — no variable for one
 * exists in `artifacts/api-server/.env.example`, which lists every provider
 * this project is configured for (Foursquare, Google Maps, Mapbox,
 * Ticketmaster, OpenAI, Frankfurter FX).
 *
 * So this is a genuinely absent capability rather than unwired code, and this
 * file is the shape it has to have when it arrives. It is a PORT plus one
 * adapter written against a published contract, and it refuses by name
 * everywhere until a credential exists.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────────
 * It does not pick a vendor for anyone. `createHttpFlightItineraryProvider`
 * takes the endpoint, the credential variable and a response mapper as
 * ARGUMENTS, because choosing and paying a flight-data vendor is a purchase
 * decision and not a code decision. `aviationStackShape` below is one
 * ready-made mapper for a widely published response shape, provided so that the
 * adapter is demonstrably complete and contract-tested rather than a sketch —
 * NOT as a recommendation, and it is bound to nothing.
 *
 * It does not fabricate. There is no "estimated" flight, no schedule
 * interpolated from a trip row, no empty itinerary standing in for an unknown
 * one. Every failure is a `ProviderRefusal` with a reason, for the same purpose
 * the corridor port states: a feasibility decision that reads an absent flight
 * as a present one is the failure mode the whole layover surface exists to
 * prevent.
 *
 * ── WHY THE SHAPE CARRIES TICKETING AND AIRPORT IDENTITY ─────────────────────
 * Two of the three reason codes `LayoverSafetyEngine` declares and never emits
 * — "no input exists in any shape", in its own words — are facts about an
 * ITINERARY, not about one flight:
 *
 *   AIRPORT_CHANGE_REQUIRED  the inbound arrives at one airport and the onward
 *                            flight leaves from a DIFFERENT one. A traveller
 *                            with a four-hour layover who must cross a city
 *                            between two airports is in a different situation
 *                            from one who stays in a terminal, and today the
 *                            product cannot tell them apart.
 *   SELF_TRANSFER_FRICTION   the two flights are on separate tickets, so no
 *                            carrier is obliged to re-accommodate a missed
 *                            connection and the traveller must clear
 *                            immigration and re-check bags themselves.
 *
 * Both are readable from an itinerary and from nothing else, which is why
 * `FlightItinerary` pairs the legs rather than answering one flight at a time.
 * `ticketing` is a three-valued fact for the usual reason: `UNKNOWN` is not
 * folded into either answer, because assuming `SINGLE_TICKET` silently
 * withholds the friction warning and assuming `SEPARATE_TICKETS` invents one.
 */
import {
  answer,
  credentialRefusal,
  refuse,
  type ProviderRefusal,
  type ProviderResult,
} from "./providerRefusal.js";

/** One flight, as a feed can state it. */
export interface FlightLeg {
  /** IATA designator as filed, e.g. "BA286". Upper-cased, no space. */
  designator: string;
  departureAirport: string;
  arrivalAirport: string;
  /** Terminal as the feed states it, or null. Never inferred. */
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  /** The published times. ISO instants. */
  scheduledDeparture: string;
  scheduledArrival: string;
  /**
   * The times the feed currently believes, when it says. `null` means the feed
   * did not state one — NOT that the flight is on time. A consumer that reads
   * `estimatedArrival ?? scheduledArrival` has quietly asserted punctuality.
   */
  estimatedDeparture: string | null;
  estimatedArrival: string | null;
  status: FlightStatus;
}

/**
 * Status as a feed states it. `UNKNOWN` is a member, not an absence, so that a
 * feed which answered without a status cannot be read as "scheduled".
 */
export const FLIGHT_STATUSES = [
  "SCHEDULED",
  "ACTIVE",
  "LANDED",
  "CANCELLED",
  "DIVERTED",
  "UNKNOWN",
] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];

/**
 * Whether the two flights are on one ticket. Three-valued on purpose — see the
 * header. A feed that does not state it yields `UNKNOWN`, which a consumer must
 * carry rather than resolve.
 */
export const TICKETING_KINDS = ["SINGLE_TICKET", "SEPARATE_TICKETS", "UNKNOWN"] as const;
export type TicketingKind = (typeof TICKETING_KINDS)[number];

/** An inbound flight and the onward flight the traveller is connecting to. */
export interface FlightItinerary {
  inbound: FlightLeg;
  onward: FlightLeg;
  ticketing: TicketingKind;
  /** When the feed's answer was read. */
  observedAt: string;
  /**
   * When this itinerary stops being a statement about now. Flight status
   * changes on the hour, so an itinerary is not a durable fact.
   */
  expiresAt: string;
  sourceRefs: string[];
}

export interface ItineraryQuery {
  /** The flight the traveller is arriving on. */
  inboundDesignator: string;
  /** The flight they are leaving on. */
  onwardDesignator: string;
  /** The local date of the inbound departure, `YYYY-MM-DD`. */
  date: string;
}

export type ItineraryResult = ProviderResult<FlightItinerary>;

export interface FlightItineraryProvider {
  readonly id: string;
  /** True only if this provider reads a real feed. Never set on a stand-in. */
  readonly live: boolean;
  itinerary(q: ItineraryQuery): Promise<ItineraryResult>;
}

/** Designators are compared upper-cased with no separator, in exactly one place. */
export function canonDesignator(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * A flight designator: a carrier code then 1-4 digits.
 *
 * THE CARRIER CODE MUST CONTAIN A LETTER, and that is not pedantry — the first
 * cut of this pattern was `[A-Z0-9]{2,3}\d{1,4}` and the contract test caught
 * it accepting the bare number "286", by reading "28" as a carrier code and "6"
 * as the flight number. A validator that accepts a flight number with no
 * airline would have sent it upstream and spent a request on it.
 *
 * The three accepted shapes are the ones that exist:
 *   [A-Z]{3}        ICAO, three letters                    BAW286
 *   [A-Z][A-Z0-9]   IATA, letter first                     BA286, U21234
 *   [0-9][A-Z]      IATA, digit first                      9W123
 */
const DESIGNATOR_RE = /^(?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function itineraryQueryRefusal(
  providerId: string,
  q: ItineraryQuery,
): ProviderRefusal | null {
  for (const [name, value] of [
    ["inboundDesignator", q.inboundDesignator],
    ["onwardDesignator", q.onwardDesignator],
  ] as const) {
    if (!DESIGNATOR_RE.test(canonDesignator(value ?? ""))) {
      return refuse(providerId, "REQUEST_INCOMPLETE", `${name} is not an IATA flight designator`);
    }
  }
  if (!DATE_RE.test(q.date ?? "")) {
    return refuse(providerId, "REQUEST_INCOMPLETE", "date must be YYYY-MM-DD");
  }
  return null;
}

/**
 * ── L283 ── AIRPORT_CHANGE_REQUIRED.
 *
 * True when the inbound lands somewhere other than where the onward flight
 * leaves from. Compared on the airport code alone: a terminal change within one
 * airport is a different and much smaller problem, and conflating them would
 * make the warning fire on most large hubs and so be ignored on the one
 * itinerary where it matters.
 */
export function airportChangeRequired(it: FlightItinerary): boolean {
  return it.inbound.arrivalAirport.toUpperCase() !== it.onward.departureAirport.toUpperCase();
}

/**
 * ── L284 ── SELF_TRANSFER_FRICTION.
 *
 * `null`, not `false`, when ticketing is UNKNOWN. This function has three
 * answers because the fact has three states, and a boolean return would force
 * the caller to pick one of the two lies the header describes.
 */
export function selfTransferFriction(it: FlightItinerary): boolean | null {
  if (it.ticketing === "UNKNOWN") return null;
  return it.ticketing === "SEPARATE_TICKETS";
}

/** Has this itinerary stopped being a statement about now? An unreadable expiry is STALE. */
export function itineraryIsStale(it: FlightItinerary, nowMs: number): boolean {
  const expiry = Date.parse(it.expiresAt);
  if (!Number.isFinite(expiry)) return true;
  return expiry <= nowMs;
}

/**
 * The connection window the feed actually supports, in minutes.
 *
 * Uses ESTIMATED times where the feed states them and SCHEDULED otherwise, and
 * says which it used. That distinction is the whole value of a feed over a trip
 * row: a schedule is what was planned, an estimate is what is happening, and a
 * consumer that cannot tell them apart has gained nothing by asking.
 *
 * Returns null when either instant is unreadable. Not zero, and not a guess —
 * zero minutes between flights would read as a missed connection.
 */
export function connectionMinutes(
  it: FlightItinerary,
): { minutes: number; basis: "ESTIMATED" | "SCHEDULED" | "MIXED" } | null {
  const arrRaw = it.inbound.estimatedArrival ?? it.inbound.scheduledArrival;
  const depRaw = it.onward.estimatedDeparture ?? it.onward.scheduledDeparture;
  const arr = Date.parse(arrRaw);
  const dep = Date.parse(depRaw);
  if (!Number.isFinite(arr) || !Number.isFinite(dep)) return null;
  const arrLive = it.inbound.estimatedArrival !== null;
  const depLive = it.onward.estimatedDeparture !== null;
  const basis = arrLive && depLive ? "ESTIMATED" : arrLive || depLive ? "MIXED" : "SCHEDULED";
  return { minutes: Math.round((dep - arr) / 60_000), basis };
}

/**
 * The provider every deployment has today: it refuses, by name, always.
 *
 * NOT an empty itinerary and NOT a schedule derived from the trip row. An
 * itinerary assembled from what a traveller typed would carry
 * `ticketing: UNKNOWN` and matching airports, which reads as "one ticket, no
 * airport change" — two reassurances about an itinerary nobody checked.
 */
export const NO_FLIGHT_FEED_PROVIDER: FlightItineraryProvider = {
  id: "no-flight-feed",
  live: false,
  async itinerary(): Promise<ItineraryResult> {
    return refuse(
      "no-flight-feed",
      "PROVIDER_UNBOUND",
      "no flight feed is configured in this deployment, and no flight-data credential exists " +
        "in this project's environment. Connection detection (L169) and the itinerary facts " +
        "behind AIRPORT_CHANGE_REQUIRED (L283) and SELF_TRANSFER_FRICTION (L284) are " +
        "unavailable. They are refused rather than guessed from the trip row.",
    );
  },
};

/**
 * A mapper turns one vendor's response body into two legs and a ticketing fact,
 * or refuses. Vendors differ enough in shape that a mapper is the only part of
 * a flight adapter worth writing per vendor; everything else — gating,
 * timeouts, status handling, staleness — is the same for all of them and lives
 * in `createHttpFlightItineraryProvider`.
 */
export type FlightResponseMapper = (
  body: unknown,
  q: ItineraryQuery,
) => { inbound: FlightLeg; onward: FlightLeg; ticketing: TicketingKind } | { error: string };

export interface HttpFlightProviderConfig {
  id: string;
  /** Built per query. Receives the canonical designator and date. */
  url: (q: ItineraryQuery, apiKey: string) => string;
  /** The environment variable holding this vendor's credential. A NAME. */
  credentialEnv: string;
  mapper: FlightResponseMapper;
  /** Extra headers, built from the key where the vendor wants it in a header. */
  headers?: (apiKey: string) => Record<string, string>;
  ttlMs?: number;
  timeoutMs?: number;
}

/** Flight status turns over on the hour; ten minutes is generous for a cache. */
export const FLIGHT_ITINERARY_TTL_MS = 10 * 60 * 1000;

/**
 * The vendor-independent half of a flight adapter, complete and tested.
 *
 * Everything here is what the owner's rule calls a completed adapter: it is
 * ready for a credential, it refuses by name without one, and the only thing
 * standing between it and working is a purchase this lane has no authority to
 * make.
 */
export function createHttpFlightItineraryProvider(
  cfg: HttpFlightProviderConfig,
  opts: { fetchImpl?: typeof fetch; readEnv?: (n: string) => string | undefined; now?: () => Date } = {},
): FlightItineraryProvider {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const readEnv = opts.readEnv ?? ((n: string) => process.env[n]);
  const now = opts.now ?? (() => new Date());
  const ttl = cfg.ttlMs ?? FLIGHT_ITINERARY_TTL_MS;
  const timeout = cfg.timeoutMs ?? 6_000;

  return {
    id: cfg.id,
    live: true,
    async itinerary(q: ItineraryQuery): Promise<ItineraryResult> {
      const bad = itineraryQueryRefusal(cfg.id, q);
      if (bad) return bad;

      const noKey = credentialRefusal(cfg.id, cfg.credentialEnv, readEnv);
      if (noKey) return noKey;
      const apiKey = readEnv(cfg.credentialEnv) as string;

      if (typeof doFetch !== "function") {
        return refuse(cfg.id, "PROVIDER_UNAVAILABLE", "no fetch implementation is available");
      }

      const canon: ItineraryQuery = {
        inboundDesignator: canonDesignator(q.inboundDesignator),
        onwardDesignator: canonDesignator(q.onwardDesignator),
        date: q.date,
      };

      let res: Response;
      try {
        res = await doFetch(cfg.url(canon, apiKey), {
          headers: { Accept: "application/json", ...(cfg.headers?.(apiKey) ?? {}) },
          signal: AbortSignal.timeout(timeout),
        });
      } catch (e) {
        return refuse(
          cfg.id,
          "PROVIDER_UNAVAILABLE",
          e instanceof Error ? `${e.name}: ${e.message}` : "fetch failed",
        );
      }

      if (res.status === 401 || res.status === 403) {
        return refuse(
          cfg.id,
          "PROVIDER_REJECTED",
          `HTTP ${res.status} — the credential is set but the vendor rejected it`,
          cfg.credentialEnv,
        );
      }
      if (res.status === 429) return refuse(cfg.id, "PROVIDER_REJECTED", "HTTP 429 — quota exhausted");
      if (!res.ok) return refuse(cfg.id, "PROVIDER_UNAVAILABLE", `HTTP ${res.status}`);

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return refuse(cfg.id, "PROVIDER_MALFORMED", "body is not JSON");
      }

      const mapped = cfg.mapper(body, canon);
      if ("error" in mapped) {
        // A vendor answering 200 with no matching flight is NOT an itinerary
        // with empty legs. It is "we did not find this", which is an absence of
        // an answer, and an absence is never a fact about the flight.
        return refuse(cfg.id, "PROVIDER_MALFORMED", mapped.error);
      }

      const observedAt = now().toISOString();
      return answer({
        inbound: mapped.inbound,
        onward: mapped.onward,
        ticketing: mapped.ticketing,
        observedAt,
        expiresAt: new Date(now().getTime() + ttl).toISOString(),
        sourceRefs: [
          "lib/providers/flightItineraryProvider.ts#createHttpFlightItineraryProvider",
          `flight-feed:${cfg.id}`,
        ],
      });
    },
  };
}

/**
 * ── ONE READY-MADE MAPPER, FOR A PUBLISHED RESPONSE SHAPE ────────────────────
 *
 * This is NOT a vendor recommendation and it is bound to nothing. It exists so
 * that `createHttpFlightItineraryProvider` is demonstrably a working adapter
 * against a real documented contract rather than an untested shape, which is
 * what the owner's rule asks for while access is handled separately.
 *
 * The shape is the widely published "flight" record: a list of records each
 * carrying `flight.iata`, `departure`/`arrival` objects with `iata`,
 * `terminal`, `scheduled` and `estimated`, and a `flight_status` string.
 *
 * TICKETING IS ALWAYS `UNKNOWN` HERE, AND THAT IS NOT AN OVERSIGHT. No flight
 * STATUS feed knows how a ticket was sold — that is a booking fact, held by the
 * issuing airline or GDS, and no such integration exists or is proposed here.
 * Returning `SINGLE_TICKET` because the two legs share a carrier code would be
 * a fabricated reassurance on exactly the itineraries L284 is about (a codeshare
 * sold as two tickets looks identical). So this mapper cannot produce
 * `SELF_TRANSFER_FRICTION`, `selfTransferFriction` answers `null` for
 * everything it maps, and that is the honest state until a booking source
 * exists.
 */
export function aviationStackShape(
  body: unknown,
  q: ItineraryQuery,
): { inbound: FlightLeg; onward: FlightLeg; ticketing: TicketingKind } | { error: string } {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return { error: "response has no `data` array" };

  const find = (designator: string): FlightLeg | null => {
    for (const row of rows) {
      const iata = (row as any)?.flight?.iata;
      if (typeof iata !== "string" || canonDesignator(iata) !== designator) continue;
      const leg = rowToLeg(row);
      if (leg) return leg;
    }
    return null;
  };

  const inbound = find(q.inboundDesignator);
  if (!inbound) return { error: `no readable record for ${q.inboundDesignator}` };
  const onward = find(q.onwardDesignator);
  if (!onward) return { error: `no readable record for ${q.onwardDesignator}` };

  return { inbound, onward, ticketing: "UNKNOWN" };
}

function mapStatus(raw: unknown): FlightStatus {
  switch (String(raw ?? "").toLowerCase()) {
    case "scheduled":
      return "SCHEDULED";
    case "active":
      return "ACTIVE";
    case "landed":
      return "LANDED";
    case "cancelled":
    case "canceled":
      return "CANCELLED";
    case "diverted":
      return "DIVERTED";
    default:
      // Anything unrecognised is UNKNOWN, never SCHEDULED. A status this code
      // cannot read is not evidence the flight is running normally.
      return "UNKNOWN";
  }
}

function iso(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function rowToLeg(row: any): FlightLeg | null {
  const dep = row?.departure;
  const arr = row?.arrival;
  const scheduledDeparture = iso(dep?.scheduled);
  const scheduledArrival = iso(arr?.scheduled);
  const depAirport = typeof dep?.iata === "string" ? dep.iata.toUpperCase() : null;
  const arrAirport = typeof arr?.iata === "string" ? arr.iata.toUpperCase() : null;
  // A leg missing any of these is not a leg. Filling a gap with the other end's
  // value, or with the scheduled time, is how a fabricated itinerary is built.
  if (!scheduledDeparture || !scheduledArrival || !depAirport || !arrAirport) return null;

  const designator = typeof row?.flight?.iata === "string" ? canonDesignator(row.flight.iata) : null;
  if (!designator) return null;

  const terminal = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

  return {
    designator,
    departureAirport: depAirport,
    arrivalAirport: arrAirport,
    departureTerminal: terminal(dep?.terminal),
    arrivalTerminal: terminal(arr?.terminal),
    scheduledDeparture,
    scheduledArrival,
    // `null` when the feed states none. Never defaulted to the scheduled time:
    // that would turn "we do not know if it is late" into "it is on time".
    estimatedDeparture: iso(dep?.estimated),
    estimatedArrival: iso(arr?.estimated),
    status: mapStatus(row?.flight_status),
  };
}
