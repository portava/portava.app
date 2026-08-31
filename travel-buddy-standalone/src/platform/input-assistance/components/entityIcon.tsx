/**
 * Internal helper — maps a canonical EntityType / AssistanceType to a lucide
 * glyph. Icon-only (never a remote <Image>) so the input-assistance primitives
 * stay within the bare-image guard and render instantly with no network.
 */
import React from 'react';
import {
  Globe, MapPin, Sparkles, Users, PlaneTakeoff, Calendar, Hash, Languages,
  Tag, Compass, Search, Clock, CornerDownLeft, AlertCircle, Wand2, ListChecks,
} from 'lucide-react-native';
import type { EntityType, AssistanceType } from '../types/inputContext.ts';
import { color, icon as iconToken } from '../../../theme/tokens.ts';

export function EntityIcon({
  entityType,
  size = iconToken.s18,
  tint = color.deep,
}: {
  entityType?: EntityType;
  size?: number;
  tint?: string;
}) {
  switch (entityType) {
    case 'city':
    case 'country':
      return <Globe size={size} color={tint} />;
    case 'neighborhood':
    case 'place':
    case 'hidden_gem':
      return <MapPin size={size} color={tint} />;
    case 'user':
    case 'buddy':
      return <Users size={size} color={tint} />;
    case 'trip':
      return <PlaneTakeoff size={size} color={tint} />;
    case 'event':
    case 'plan':
      return <Calendar size={size} color={tint} />;
    case 'hashtag':
      return <Hash size={size} color={tint} />;
    case 'language':
      return <Languages size={size} color={tint} />;
    case 'interest':
      return <Tag size={size} color={tint} />;
    default:
      return <Sparkles size={size} color={tint} />;
  }
}

/** Icon keyed by the assistance TYPE (used when there is no entity to key on). */
export function AssistanceTypeIcon({
  assistanceType,
  size = iconToken.s18,
  tint = color.mute,
}: {
  assistanceType: AssistanceType;
  size?: number;
  tint?: string;
}) {
  switch (assistanceType) {
    case 'completion':
      return <Search size={size} color={tint} />;
    case 'recent':
      return <Clock size={size} color={tint} />;
    case 'action':
      return <CornerDownLeft size={size} color={tint} />;
    case 'correction':
      return <AlertCircle size={size} color={tint} />;
    case 'validation':
      return <ListChecks size={size} color={tint} />;
    case 'ai_suggestion':
      return <Wand2 size={size} color={tint} />;
    case 'disambiguation':
      return <Compass size={size} color={tint} />;
    default:
      return <Sparkles size={size} color={tint} />;
  }
}
