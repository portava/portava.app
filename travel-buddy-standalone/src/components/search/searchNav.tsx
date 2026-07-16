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

  // Places and hidden gems both land on /gems/:id
  const hiddenGemMatch = destinationRoute.match(/^\/hidden-gem\/(.+)$/);
  if (hiddenGemMatch) return `/gems/${hiddenGemMatch[1]}`;

  const placeMatch = destinationRoute.match(/^\/place\/(.+)$/);
  if (placeMatch) return `/gems/${placeMatch[1]}`;

  // Cities and countries share /destination/:slug
  const cityMatch = destinationRoute.match(/^\/city\/(.+)$/);
  if (cityMatch) return `/destination/${cityMatch[1]}`;

  const countryMatch = destinationRoute.match(/^\/country\/(.+)$/);
  if (countryMatch) return `/destination/${countryMatch[1]}`;

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
