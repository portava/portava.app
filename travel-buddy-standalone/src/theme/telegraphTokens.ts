/**
 * Telegraph design tokens — messaging surface language.
 * Soft off-white surface (distinct from Passport cream), dark-green sent
 * bubbles (on-brand with passport ink), white received bubbles.
 * Purely visual: shared by inbox, conversation, group chat, and requests.
 */
import type { TextStyle, ViewStyle } from 'react-native';
import { color } from './tokens.ts';

export const TG = {
  /** Screen background — soft off-white, distinct from Passport cream #F8F3E8 */
  surface: '#F7F6F3',
  /** Raised surfaces (header, composer, cards) */
  surfaceRaised: '#FFFFFF',
  /** Sent bubble — dark green (passport ink family) */
  sentBubble: '#1A3A2A',
  sentText: '#FFFFFF',
  sentTextMute: 'rgba(255,255,255,0.66)',
  /** Received bubble */
  recvBubble: '#FFFFFF',
  recvBorder: 'rgba(0,0,0,0.07)',
  recvText: color.ink,
  /** Accent / unread — reuse existing signal token */
  accent: color.signal,
  /** Hairlines & separators on the Telegraph surface */
  hairline: 'rgba(0,0,0,0.08)',
  /** Subtle chip / pill fill on surface */
  chipFill: 'rgba(0,0,0,0.05)',
} as const;

export const TG_AVATAR = {
  /** Inbox row avatar */
  row: 48,
  /** Conversation header avatar */
  header: 36,
  /** In-thread group message avatar */
  message: 28,
  /** Request card avatar */
  request: 52,
} as const;

export const TG_SPACING = {
  /** Vertical gap between message groups (different sender / time break) */
  groupGap: 12,
  /** Vertical gap between consecutive messages from the same sender */
  intraGap: 2,
  /** Bubble corner radius */
  bubbleRadius: 18,
  /** Tight corner on the trailing edge of the last bubble in a group */
  bubbleTail: 5,
} as const;

/** Faint monospace meta text (timestamps, pills) used across Telegraph. */
export const TG_META: TextStyle = {
  fontSize: 10,
  fontFamily: 'Courier',
  letterSpacing: 0.3,
  color: color.faint,
};

/** Small "Translated" pill / status chip container. */
export const TG_PILL: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 4,
  alignSelf: 'flex-start',
  backgroundColor: TG.chipFill,
  borderRadius: 999,
  paddingHorizontal: 8,
  paddingVertical: 2,
};
