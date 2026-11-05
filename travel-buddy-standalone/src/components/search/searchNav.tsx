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

// Route mapping lives in searchRoute.ts (no React imports, so it is unit
// tested under node:test); re-exported here so every surface keeps one import.
export { resolveRoute, taxonomySearchTerm } from './searchRoute.ts';
