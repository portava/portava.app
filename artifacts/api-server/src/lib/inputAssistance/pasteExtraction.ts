/**
 * §24 Paste Intelligence — classify a pasted blob, then resolve every item it
 * contains through the SAME gateway typed text goes through (census G154–G157,
 * G161, G162; flow GII-F08).
 *
 * WHAT THIS IS NOT: a second resolver. Classification here only decides WHAT
 * was pasted (coordinates, a map link, a list, an itinerary, one place) and
 * cuts it into items. Every item that carries text is then handed to
 * `generateSuggestionsWithCoverage` — the typed path's own entry point — so a
 * pasted "hcmc" is resolved by the same alias table, stroke fold, privacy gate
 * and ranking as a typed one. Coordinates are first named by the existing
 * server-side reverse geocoder and the NAME is then resolved the same way.
 *
 * WHAT IT NEVER DOES: write. §24 — "Bulk extraction must always lead to a
 * review screen before persistent mutation." This module reads; the client's
 * review screen is the only thing that can persist, and only what the person
 * ticked. The response says `mutated: false` so no caller can mistake it.
 *
 * FAILURE HONESTY (the DV-83 principle). An item has four outcomes and they are
 * never merged: `resolved`, `no_match` (the sources ANSWERED and nothing
 * matched), `failed` (a source could not be read — the gateway's coverage
 * refusal, a thrown serve, a geocoder that did not answer) and `unsupported`
 * (a link shape no configured parser reads, e.g. a shortened link). A failed
 * read is never reported as "nothing found".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateSuggestionsWithCoverage } from './gateway';
import { POLICY_VERSION } from './policyRegistry';
import { timezoneForCoords } from './geoResolver';
import { splitSequence } from './semanticParser';
import type { InputContext, InputFieldPolicy, InputSuggestion, SuggestSessionContext } from './types';
import { reverseGeocodeOutcome, type ReverseGeocodeOutcome } from '../../services/geocodingService';

/** A paste longer than this is cut, and the response says so. */
export const PASTE_MAX_CHARS = 5000;
/** At most this many items are resolved per paste; the rest are reported as truncated. */
export const PASTE_MAX_ITEMS = 25;
/** Candidates returned per item — enough to correct a wrong first pick on the review screen. */
export const PASTE_CANDIDATES_PER_ITEM = 3;
const MAX_QUERY_CHARS = 120;

/**
 * The fields a paste can be extracted INTO. Each is a place-or-city picker whose
 * accepted value is a location; bulk extraction into a username, a caption or a
 * message has no meaning and is refused rather than guessed at.
 */
export const PASTE_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'trip_destination',
  'trip_stop_place',
  'place_picker',
  'city_picker',
  'event_location',
]);

export type PasteShape = 'coordinates' | 'map_link' | 'list' | 'itinerary' | 'single' | 'empty';
export type PasteSource = 'coordinates' | 'map_link' | 'text';
export type MapLinkProvider = 'google' | 'apple' | 'osm' | 'geo_uri';
export type UnsupportedLink = 'short_link' | 'unsupported_link';

export interface PasteItem {
  index: number;
  /** The sanitized line this item came from (bounded; safe to render as text). */
  raw: string;
  source: PasteSource;
  provider: MapLinkProvider | null;
  /** The text resolved through the gateway, or null for a bare coordinate. */
  query: string | null;
  lat: number | null;
  lng: number | null;
  /** "7", "7:30pm" — an itinerary time, carried for the review screen, never searched. */
  timeHint: string | null;
  /** "Friday", "Day 2" — the itinerary heading this item sits under. */
  dayLabel: string | null;
  unsupported: UnsupportedLink | null;
}

export interface PasteClassification {
  shape: PasteShape;
  items: PasteItem[];
  truncated: boolean;
}

// ── Sanitizing (§47: "Sanitize pasted URLs and untrusted text before rendering") ─

/**
 * Strip what must never reach a renderer or a query: bidi overrides and
 * zero-width characters (which can make a pasted line DISPLAY as something it
 * is not), and control characters other than newline. NFC so a decomposed
 * paste and a composed one are the same text. Bounded.
 */
export function sanitizePastedText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .slice(0, PASTE_MAX_CHARS * 2)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .slice(0, PASTE_MAX_CHARS);
}

// ── Coordinates (G157) ─────────────────────────────────────────────────────────

function inRange(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const DECIMAL_PAIR = /^\(?\s*([+-]?\d{1,3}\.\d{2,})\s*[,;\s]\s*([+-]?\d{1,3}\.\d{2,})\s*\)?$/;
const HEMISPHERE_PAIR = /^(\d{1,3}(?:\.\d+)?)\s*°?\s*([NS])\s*[,;\s]\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])$/i;
const DMS_PAIR =
  /^(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|″|'')?\s*([NS])\s*[,;\s]?\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|″|'')?\s*([EW])$/i;

/**
 * A coordinate pair in the three forms people paste: `16.0544, 108.2022`,
 * `33.8568° S, 151.2153° E`, and Google's DMS copy `16°03'15.8"N 108°12'07.9"E`.
 * Bare integers ("12, 7") are NOT coordinates — that is a list of numbers.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const s = (text ?? '').trim();
  let m = s.match(DECIMAL_PAIR);
  if (m) {
    const lat = parseFloat(m[1]!);
    const lng = parseFloat(m[2]!);
    return inRange(lat, lng) ? { lat, lng } : null;
  }
  m = s.match(HEMISPHERE_PAIR);
  if (m) {
    const lat = parseFloat(m[1]!) * (m[2]!.toUpperCase() === 'S' ? -1 : 1);
    const lng = parseFloat(m[3]!) * (m[4]!.toUpperCase() === 'W' ? -1 : 1);
    return inRange(lat, lng) ? { lat, lng } : null;
  }
  m = s.match(DMS_PAIR);
  if (m) {
    const deg = (d: string, mi: string, se: string) => parseFloat(d) + parseFloat(mi) / 60 + parseFloat(se) / 3600;
    const lat = round6(deg(m[1]!, m[2]!, m[3]!) * (m[4]!.toUpperCase() === 'S' ? -1 : 1));
    const lng = round6(deg(m[5]!, m[6]!, m[7]!) * (m[8]!.toUpperCase() === 'W' ? -1 : 1));
    return inRange(lat, lng) ? { lat, lng } : null;
  }
  return null;
}

// ── Map links (G156) ──────────────────────────────────────────────────────────

export interface MapLinkStop {
  query: string | null;
  lat: number | null;
  lng: number | null;
}

export interface MapLinkParse {
  provider: MapLinkProvider | null;
  stops: MapLinkStop[];
  unsupported: UnsupportedLink | null;
}

function decodePart(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
  } catch {
    return s.replace(/\+/g, ' ').trim();
  }
}

/** A coordinate pair as a map link carries it: `16.05,108.2` (a link's own precision). */
function linkCoords(value: string): { lat: number; lng: number } | null {
  const m = value.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]!);
  const lng = parseFloat(m[2]!);
  return inRange(lat, lng) ? { lat, lng } : null;
}

/** A query-string value that is either a coordinate pair or a place name. */
function stopFromValue(value: string | null, coords: { lat: number; lng: number } | null = null): MapLinkStop | null {
  const v = value ? decodePart(value) : '';
  const asCoords = v ? (linkCoords(v) ?? parseCoordinates(v)) : null;
  if (asCoords) return { query: null, ...asCoords };
  if (!v && !coords) return null;
  return { query: v ? v.slice(0, MAX_QUERY_CHARS) : null, lat: coords?.lat ?? null, lng: coords?.lng ?? null };
}

const AT_COORDS = /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/;

function atCoords(path: string): { lat: number; lng: number } | null {
  const m = path.match(AT_COORDS);
  if (!m) return null;
  const lat = parseFloat(m[1]!);
  const lng = parseFloat(m[2]!);
  return inRange(lat, lng) ? { lat, lng } : null;
}

const SHORT_LINK_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'g.co', 'bit.ly', 'tinyurl.com']);

/**
 * Parse a map link from a configured provider. Returns null for anything that is
 * not an http(s) or geo: URL (a `javascript:` string is not a link we read).
 * A link we recognise as a link but cannot read — a shortener, whose target is
 * only known by following a redirect this endpoint will not follow, or a host no
 * parser is configured for — comes back with `unsupported` set, so the review
 * screen can SAY so instead of dropping it.
 */
export function parseMapLink(text: string): MapLinkParse | null {
  const s = (text ?? '').trim();
  if (/^geo:/i.test(s)) {
    const m = s.match(/^geo:(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:[;,][^?]*)?(?:\?(.*))?$/i);
    if (!m) return { provider: 'geo_uri', stops: [], unsupported: 'unsupported_link' };
    const coords = { lat: parseFloat(m[1]!), lng: parseFloat(m[2]!) };
    const q = m[3] ? new URLSearchParams(m[3]).get('q') : null;
    const label = q ? decodePart(q).replace(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\s*/, '').replace(/^\((.*)\)$/, '$1') : '';
    if (!inRange(coords.lat, coords.lng)) return { provider: 'geo_uri', stops: [], unsupported: 'unsupported_link' };
    return { provider: 'geo_uri', stops: [{ query: label || null, ...coords }], unsupported: null };
  }
  if (!/^https?:\/\//i.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const params = url.searchParams;

  if (SHORT_LINK_HOSTS.has(host)) return { provider: host.includes('goo') ? 'google' : null, stops: [], unsupported: 'short_link' };

  const isGoogle = /(^|\.)google\.[a-z.]+$/.test(host) && (host.startsWith('maps.') || url.pathname.startsWith('/maps'));
  if (isGoogle) {
    const path = url.pathname;
    const coords = atCoords(path);
    const segs = path.split('/').filter(Boolean);
    const dirIdx = segs.indexOf('dir');
    if (dirIdx >= 0) {
      const stops = segs
        .slice(dirIdx + 1)
        .filter((p) => !p.startsWith('@') && !p.startsWith('data='))
        .map((p) => stopFromValue(p))
        .filter((x): x is MapLinkStop => x !== null);
      return { provider: 'google', stops, unsupported: stops.length ? null : 'unsupported_link' };
    }
    const placeIdx = segs.indexOf('place');
    const searchIdx = segs.indexOf('search');
    const named = placeIdx >= 0 ? segs[placeIdx + 1] : searchIdx >= 0 ? segs[searchIdx + 1] : undefined;
    if (named && !named.startsWith('@')) {
      const stop = stopFromValue(named, coords);
      if (stop) return { provider: 'google', stops: [stop], unsupported: null };
    }
    const qp = params.get('q') ?? params.get('query') ?? params.get('destination') ?? params.get('daddr') ?? params.get('ll') ?? params.get('center');
    const fromParam = stopFromValue(qp, coords);
    if (fromParam) return { provider: 'google', stops: [fromParam], unsupported: null };
    if (coords) return { provider: 'google', stops: [{ query: null, ...coords }], unsupported: null };
    return { provider: 'google', stops: [], unsupported: 'unsupported_link' };
  }

  if (host === 'maps.apple.com') {
    const ll = params.get('ll') ?? params.get('sll');
    const coords = ll ? linkCoords(decodePart(ll)) : null;
    const name = params.get('q') ?? params.get('daddr') ?? params.get('address');
    const stop = stopFromValue(name, coords) ?? (coords ? { query: null, ...coords } : null);
    return stop ? { provider: 'apple', stops: [stop], unsupported: null } : { provider: 'apple', stops: [], unsupported: 'unsupported_link' };
  }

  if (host === 'openstreetmap.org' || host.endsWith('.openstreetmap.org') || host === 'osm.org') {
    const mlat = params.get('mlat');
    const mlon = params.get('mlon');
    if (mlat && mlon) {
      const lat = parseFloat(mlat);
      const lng = parseFloat(mlon);
      if (inRange(lat, lng)) return { provider: 'osm', stops: [{ query: null, lat, lng }], unsupported: null };
    }
    const hash = url.hash.match(/map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (hash) {
      const lat = parseFloat(hash[1]!);
      const lng = parseFloat(hash[2]!);
      if (inRange(lat, lng)) return { provider: 'osm', stops: [{ query: null, lat, lng }], unsupported: null };
    }
    const query = stopFromValue(params.get('query'));
    return query ? { provider: 'osm', stops: [query], unsupported: null } : { provider: 'osm', stops: [], unsupported: 'unsupported_link' };
  }

  return { provider: null, stops: [], unsupported: 'unsupported_link' };
}

// ── Lists and itineraries (G155 / G161) ──────────────────────────────────────

const BULLET = /^\s*(?:[-*•·◦▪–—]|\d{1,2}[.)]|[a-z][.)])\s+/i;
const DAY_WORD =
  '(?:day\\s*\\d{1,2}|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tonight|tomorrow|weekend)';
const DAY_HEADER = new RegExp(`^(${DAY_WORD}(?:[\\s,]+[\\w\\s]{0,20})?)\\s*:\\s*(.*)$`, 'i');
const BARE_HEADER = /^([^:]{1,30}):$/;
/** "at 7", "around 11:30pm", "by 9", "@ 8", plus standalone "7pm" / "19:00". */
const TIME_HINT =
  /(?:\s*[,-]?\s*\b(?:at|around|by|from|until|til)\s+|\s*@\s*)(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h)?)\b|\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/i;
const SEQUENCE_SEPARATORS = /\s*(?:→|->|=>|⇒|›|»|;|\|)\s*/;

function stripTime(text: string): { query: string; timeHint: string | null } {
  const m = text.match(TIME_HINT);
  if (!m) return { query: text.trim(), timeHint: null };
  const hint = (m[1] ?? m[2] ?? '').replace(/\s+/g, '').trim();
  const query = (text.slice(0, m.index) + ' ' + text.slice((m.index ?? 0) + m[0].length))
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:-]+|[\s,:-]+$/g, '')
    .trim();
  return { query, timeHint: hint || null };
}

function isUrlLine(line: string): boolean {
  return /^(?:https?:\/\/|geo:)\S+$/i.test(line.trim());
}

function textItems(line: string, dayLabel: string | null): Array<Omit<PasteItem, 'index'>> {
  const out: Array<Omit<PasteItem, 'index'>> = [];
  const parts = line
    .split(SEQUENCE_SEPARATORS)
    .flatMap((p) => splitSequence(p))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const part of parts.length > 0 ? parts : [line]) {
    const { query, timeHint } = stripTime(part);
    if (!query) continue;
    out.push({
      raw: part.slice(0, 200),
      source: 'text',
      provider: null,
      query: query.slice(0, MAX_QUERY_CHARS),
      lat: null,
      lng: null,
      timeHint,
      dayLabel,
      unsupported: null,
    });
  }
  return out;
}

function lineItems(line: string, dayLabel: string | null): Array<Omit<PasteItem, 'index'>> {
  const coords = parseCoordinates(line);
  if (coords) {
    return [{ raw: line.slice(0, 200), source: 'coordinates', provider: null, query: null, ...coords, timeHint: null, dayLabel, unsupported: null }];
  }
  if (isUrlLine(line)) {
    const link = parseMapLink(line);
    if (!link) return [];
    if (link.unsupported || link.stops.length === 0) {
      return [{ raw: line.slice(0, 200), source: 'map_link', provider: link.provider, query: null, lat: null, lng: null, timeHint: null, dayLabel, unsupported: link.unsupported ?? 'unsupported_link' }];
    }
    return link.stops.map((stop) => ({
      raw: line.slice(0, 200),
      source: 'map_link' as const,
      provider: link.provider,
      query: stop.query,
      lat: stop.lat,
      lng: stop.lng,
      timeHint: null,
      dayLabel,
      unsupported: null,
    }));
  }
  return textItems(line, dayLabel);
}

/**
 * Cut a pasted blob into items. Pure. A comma is deliberately NOT a separator:
 * "2 Bach Dang, Hai Chau, Da Nang" is one address, and splitting it would turn
 * one place into three wrong ones. Lists are lines, bullets, arrows,
 * semicolons, pipes and the sequence words the semantic parser already splits
 * on ("then", "after that").
 */
export function classifyPaste(rawText: unknown): PasteClassification {
  const original = typeof rawText === 'string' ? rawText : '';
  const text = sanitizePastedText(original);
  let truncated = original.length > PASTE_MAX_CHARS;
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { shape: 'empty', items: [], truncated };

  const collected: Array<Omit<PasteItem, 'index'>> = [];
  let dayLabel: string | null = null;
  let sawItinerarySignal = false;
  for (const rawLine of lines) {
    let line = rawLine.replace(BULLET, '').trim();
    if (!line) continue;
    if (!isUrlLine(line)) {
      const header = line.match(DAY_HEADER);
      if (header) {
        dayLabel = header[1]!.trim().slice(0, 40);
        sawItinerarySignal = true;
        line = header[2]!.trim();
        if (!line) continue;
      } else {
        const bare = line.match(BARE_HEADER);
        if (bare) {
          dayLabel = bare[1]!.trim().slice(0, 40);
          sawItinerarySignal = true;
          continue;
        }
      }
    }
    collected.push(...lineItems(line, dayLabel));
  }

  if (collected.length > PASTE_MAX_ITEMS) truncated = true;
  const items = collected.slice(0, PASTE_MAX_ITEMS).map((it, index) => ({ ...it, index }));
  if (items.some((i) => i.timeHint)) sawItinerarySignal = true;

  let shape: PasteShape;
  if (items.length === 0) shape = 'empty';
  else if (sawItinerarySignal) shape = 'itinerary';
  else if (items.length > 1) shape = 'list';
  else if (items[0]!.source === 'coordinates') shape = 'coordinates';
  else if (items[0]!.source === 'map_link') shape = 'map_link';
  else shape = 'single';
  return { shape, items, truncated };
}

// ── Resolution through the shared gateway (G154) ──────────────────────────────

export type PasteItemStatus = 'resolved' | 'no_match' | 'failed' | 'unsupported';

export interface ResolvedPasteItem extends PasteItem {
  status: PasteItemStatus;
  /** Why an item failed, was unsupported or did not match. Safe, fixed copy. */
  reason: string | null;
  /** True when some sources could not be read but others still produced candidates. */
  partial: boolean;
  candidates: InputSuggestion[];
}

export interface PasteResolveParams {
  context: InputContext;
  policy: InputFieldPolicy;
  userId: string;
  sessionContext?: SuggestSessionContext;
  tz?: string | null;
}

export interface PasteResolveDeps {
  generate?: typeof generateSuggestionsWithCoverage;
  reverseGeocode?: (lat: number, lng: number) => Promise<ReverseGeocodeOutcome>;
}

const UNSUPPORTED_COPY: Record<UnsupportedLink, string> = {
  short_link: 'Shortened map links can’t be read. Open the link and copy the full address from the browser.',
  unsupported_link: 'This link isn’t from a map we can read (Google Maps, Apple Maps, OpenStreetMap).',
};

type GatewayOutcome =
  | { kind: 'answered'; suggestions: InputSuggestion[]; partial: boolean }
  | { kind: 'failed'; reason: string };

async function resolveText(
  sc: SupabaseClient,
  params: PasteResolveParams,
  text: string,
  coords: { lat: number | null; lng: number | null },
  generate: typeof generateSuggestionsWithCoverage,
): Promise<GatewayOutcome> {
  try {
    const { suggestions, refusal } = await generate(sc, {
      context: params.context,
      policy: params.policy,
      text,
      userId: params.userId,
      limit: PASTE_CANDIDATES_PER_ITEM,
      sessionContext: params.sessionContext,
      lat: coords.lat,
      lng: coords.lng,
      city: null,
      tz: params.tz ?? null,
    });
    // Only rows that resolve to an entity are candidates; a typo-correction or
    // validation row is advice for a typing person, not a place to add.
    const rows = suggestions.filter((s) => !!s.entityType && s.type !== 'correction' && s.type !== 'validation').slice(0, PASTE_CANDIDATES_PER_ITEM);
    if (rows.length === 0 && refusal) {
      return { kind: 'failed', reason: 'We couldn’t check this one — the place lookup didn’t answer.' };
    }
    return { kind: 'answered', suggestions: rows, partial: !!refusal };
  } catch {
    return { kind: 'failed', reason: 'We couldn’t check this one — the place lookup failed.' };
  }
}

/** A candidate named by the reverse geocoder when the canonical registry has no row for it. */
function providerCandidate(
  item: PasteItem,
  context: InputContext,
  place: { city: string; country: string | null; countryCode: string | null },
): InputSuggestion {
  const binding = {
    entityType: 'city' as const,
    cityId: '',
    city: place.city,
    country: place.country,
    countryCode: place.countryCode,
    lat: item.lat,
    lng: item.lng,
    timezone: timezoneForCoords(item.lat, item.lng),
  };
  return {
    id: `paste-geo-${item.index}`,
    type: 'entity',
    context,
    label: place.city,
    subtitle: place.country ?? undefined,
    entityType: 'city',
    action: { type: 'set_structured_value', value: binding },
    structuredValue: binding,
    confidence: 0.6,
    source: 'provider',
    reason: 'Named from the map coordinates',
    policyVersion: POLICY_VERSION,
  };
}

async function resolveOne(
  sc: SupabaseClient,
  params: PasteResolveParams,
  item: PasteItem,
  deps: Required<PasteResolveDeps>,
): Promise<ResolvedPasteItem> {
  const done = (status: PasteItemStatus, reason: string | null, candidates: InputSuggestion[] = [], partial = false): ResolvedPasteItem =>
    ({ ...item, status, reason, partial, candidates });

  if (item.unsupported) return done('unsupported', UNSUPPORTED_COPY[item.unsupported]);

  const coords = { lat: item.lat, lng: item.lng };
  if (item.query) {
    const res = await resolveText(sc, params, item.query, coords, deps.generate);
    if (res.kind === 'failed') return done('failed', res.reason);
    if (res.suggestions.length > 0) return done('resolved', null, res.suggestions, res.partial);
    // A named map pin the registry does not know still has a position: fall
    // through to naming the position, rather than calling it "no match".
    if (item.lat === null || item.lng === null) return done('no_match', `No place matched “${item.query}”.`);
  }

  if (item.lat === null || item.lng === null) return done('no_match', 'Nothing to look up.');
  const geo = await deps.reverseGeocode(item.lat, item.lng).catch(
    (): ReverseGeocodeOutcome => ({ ok: false, reason: 'geocoder_threw' }),
  );
  if (!geo.ok) return done('failed', 'We couldn’t name this point — the geocoding service didn’t answer.');
  const city = geo.place.city ?? null;
  if (!city) return done('no_match', 'No town or city is recorded at this point.');

  const res = await resolveText(sc, params, city, coords, deps.generate);
  if (res.kind === 'answered' && res.suggestions.length > 0) return done('resolved', null, res.suggestions, res.partial);
  // The point IS named; the registry just could not confirm it. Offer the
  // provider's name, marked as such, and say whether the registry failed.
  return done(
    'resolved',
    null,
    [providerCandidate(item, params.context, { city, country: geo.place.country, countryCode: geo.place.countryCode })],
    res.kind === 'failed',
  );
}

/**
 * Resolve every classified item. Sequential on purpose: the reverse geocoder is
 * rate-limited (Nominatim: 1 request/second) and a paste is bounded at
 * {@link PASTE_MAX_ITEMS}, so ordering beats a burst the provider would refuse.
 */
export async function resolvePaste(
  sc: SupabaseClient,
  params: PasteResolveParams,
  classification: PasteClassification,
  deps: PasteResolveDeps = {},
): Promise<ResolvedPasteItem[]> {
  const full: Required<PasteResolveDeps> = {
    generate: deps.generate ?? generateSuggestionsWithCoverage,
    reverseGeocode: deps.reverseGeocode ?? reverseGeocodeOutcome,
  };
  const out: ResolvedPasteItem[] = [];
  for (const item of classification.items) {
    out.push(await resolveOne(sc, params, item, full));
  }
  return out;
}
