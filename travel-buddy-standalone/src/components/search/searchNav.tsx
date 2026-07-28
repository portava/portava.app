/**
 * Shared search-result navigation + iconography.
 *
 * Single source of truth for mapping backend SearchResult entries to Expo
 * Router paths and per-type icons. Used by SearchResultCard (full results)
 * and SearchSuggestionsPanel (typeahead) so both surfaces navigate and
 * label entity types identically — no duplicated route tables.
 */
import React from 'react';
import {
  Users, Calendar, PlaneTakeoff, MapPin, Hash, FileText, Globe, Award, Sparkles,
} from 'lucide-react-native';
import type { UnifiedSearchResult } from '../../services/discovery.ts';
import { color } from '../../theme/tokens.ts';

export function TypeIcon({ type, size = 15, tint }: { type: string; size?: number; tint?: string }) {
  const c = tint ?? color.deep;
  switch (type) {
    case 'travelers': case 'buddies': case 'circles': return <Users size={size} color={c} />;
    case 'events': case 'plans': return <Calendar size={size} color={c} />;
    case 'trips': return <PlaneTakeoff size={size} color={c} />;
    case 'places': case 'hidden_gems': return <MapPin size={size} color={c} />;
    case 'hashtags': return <Hash size={size} color={c} />;
    case 'posts': return <FileText size={size} color={c} />;
    case 'cities': case 'countries': return <Globe size={size} color={c} />;
    case 'stamps': return <Award size={size} color={c} />;
    default: return <Sparkles size={size} color={c} />;
  }
}

/**
 * Normalises backend destinationRoute values to actual Expo Router paths.
 *
 * - Travelers: /passport/:handle is valid — app/passport/[username].tsx exists.
 * - Buddies: override to /(rent-a-buddy)/buddy/:id (app/(rent-a-buddy)/buddy/[id].tsx).
 *   Backend emits /passport/:handle for buddies (same searchTravelers fn), but the
 *   dedicated buddy profile is at /(rent-a-buddy)/buddy/:id.
 * - Places + hidden gems: /place/:id and /hidden-gem/:id → /gems/:id.
 * - Cities + countries: /city/:slug and /country/:slug → /destination/:slug.
 * - Stamps: /stamps/:slug (plural backend) → /stamp/:slug (singular app).
 * - Circles: app only has a singleton /circle screen (no parameterised :id route,
 *   see circle.tsx comment line ~128). We pass `ownerId` as a query param to preserve
 *   entity identity in the URL for future use when a parameterised route is added.
 * - All other routes (/event/:id, /trip/:id, /plan, /hashtag/:slug, /post/:id, …)
 *   pass through verbatim.
 */
export function resolveRoute(result: UnifiedSearchResult): string | null {
  const { destinationRoute, type, id } = result;
  if (!destinationRoute) return null;

  // Buddies → dedicated rent-a-buddy buddy profile page
  if (type === 'buddies') {
    return `/(rent-a-buddy)/buddy/${id}`;
  }

  // Places and hidden gems both land on /gems/:id, UNLESS the result carries a
  // livingPageId in its metadata — then it routes to the canonical Living
  // Destination Page at /place/:livingPageId instead.
  const hiddenGemMatch = destinationRoute.match(/^\/hidden-gem\/(.+)$/);
  if (hiddenGemMatch) return `/gems/${hiddenGemMatch[1]}`;

  const placeMatch = destinationRoute.match(/^\/place\/(.+)$/);
  if (placeMatch) {
    // livingPageId is set when the discovery_place has been linked to a
    // canonical places row.  Route to the Living Destination Page in that
    // case; fall back to the existing /gems sheet for unlinked places.
    const livingPageId = result.metadata?.livingPageId as string | undefined;
    if (livingPageId) return `/place/${livingPageId}`;
    return `/gems/${placeMatch[1]}`;
  }

  // Cities and countries share /destination/:slug
  // For city results the subtitle carries the country name (or "Region, Country"
  // for typeahead suggestions). Extract the last comma-segment so both formats
  // ("Philippines" and "California, United States") resolve to a clean country
  // name that toFsqCityKey can look up.
  const cityMatch = destinationRoute.match(/^\/city\/(.+)$/);
  if (cityMatch) {
    const rawSub = result.subtitle?.trim() ?? '';
    const country = rawSub.includes(',')
      ? rawSub.split(',').pop()!.trim()
      : rawSub;
    const countrySuffix = country ? `?country=${encodeURIComponent(country)}` : '';
    return `/destination/${cityMatch[1]}${countrySuffix}`;
  }

  const countryMatch = destinationRoute.match(/^\/country\/(.+)$/);
  if (countryMatch) {
    // For country results the country name is in result.title; fall back to
    // humanising the slug (e.g. "philippines" → "Philippines") so toFsqCityKey
    // can build the correct FSQ city key on the destination screen.
    const country = result.title?.trim()
      || countryMatch[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const countrySuffix = country ? `?country=${encodeURIComponent(country)}` : '';
    return `/destination/${countryMatch[1]}${countrySuffix}`;
  }

  // Stamps: /stamps/:slug (plural backend) → /stamp/:slug (singular app file)
  const stampsMatch = destinationRoute.match(/^\/stamps\/(.+)$/);
  if (stampsMatch) return `/stamp/${stampsMatch[1]}`;

  // Circles: the app only has a singleton /circle screen (per-user, no :id param).
  // Pass ownerId as a query param to preserve entity identity; a parameterised
  // /circle/:id route can read this when it is eventually added.
  if (destinationRoute.startsWith('/circle')) {
    const circleIdMatch = destinationRoute.match(/^\/circle\/(.+)$/);
    return circleIdMatch ? `/circle?ownerId=${circleIdMatch[1]}` : '/circle';
  }

  // All others: /passport/:handle, /event/:id, /trip/:id, /hashtag/:slug, /post/:id, …
  return destinationRoute;
}
