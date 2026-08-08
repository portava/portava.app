/**
 * PrivateEventCard — shared component for private / invite-only event views.
 *
 * Rendered when the API returns a private-event sentinel (isPrivate: true)
 * instead of the full EventDetail. Shows ONLY the minimal safe fields:
 * cover image or generic fallback, event name, "Private Event" badge,
 * host display name and @handle, and a Request to Join / Requested button.
 *
 * Deliberately does NOT render address, venue, times, description, attendee
 * info, or any other restricted field.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { CachedImage } from '../CachedImage.tsx';
import { Lock, Calendar, Clock } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { requestToJoinEvent } from '../../services/events.ts';

/** Minimal safe fields returned by the private-event sentinel. */
export interface PrivateEventPreview {
  /** Discriminant — always true when this shape is returned. */
  isPrivate: true;
  id: string;
  /** Event name — safe to expose (title is public-facing). */
  title: string | null;
  /** Cover image URL or null — fall back to generic private-event cover. */
  coverImageUrl: string | null;
  /** Host display name — safe to expose for the "hosted by" line. */
  hostDisplayName: string | null;
  /** Host @handle — used for the subline. */
  hostHandle: string | null;
  /** Host user ID — used if the host avatar is loaded later. */
  hostId: string | null;
  /**
   * Join request status for the current viewer:
   *   'pending' → "Requested" state (button disabled)
   *   null      → CTA "Request to Join" is shown
   */
  myJoinRequestStatus: 'pending' | null;
}

interface Props {
  event: PrivateEventPreview;
  /** Optional callback fired after a successful join request. */
  onRequestSent?: () => void;
}

export function PrivateEventCard({ event, onRequestSent }: Props) {
  const [pending, setPending] = useState(event.myJoinRequestStatus === 'pending');
  const [busy, setBusy] = useState(false);

  const hostLine = event.hostDisplayName ?? (event.hostHandle ? `@${event.hostHandle}` : 'Unknown host');
  const hostHandle = event.hostHandle ? `@${event.hostHandle}` : null;

  async function handleRequest() {
    if (pending || busy) return;
    setBusy(true);
    try {
      const res = await requestToJoinEvent(event.id);
      if (res.ok) {
        setPending(true);
        onRequestSent?.();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.card}>
      {/* Cover image or generic placeholder */}
      <View style={s.cover}>
        {event.coverImageUrl != null ? (
          <CachedImage
            source={{ uri: event.coverImageUrl }}
            style={s.coverImage}
            accessibilityLabel="Event cover"
          />
        ) : (
          <View style={[s.coverImage, s.coverFallback]}>
            <Calendar size={40} color={color.haze} />
          </View>
        )}
        {/* Private event badge overlaid on cover */}
        <View style={s.coverBadge}>
          <Lock size={11} color="#fff" />
          <Text style={s.coverBadgeText}>Private Event</Text>
        </View>
      </View>

      <View style={s.body}>
        {/* Event title */}
        <Text style={s.title} numberOfLines={2}>
          {event.title ?? 'Private Event'}
        </Text>

        {/* Host info */}
        <View style={s.hostRow}>
          <Text style={s.hostLabel}>Hosted by </Text>
          <Text style={s.hostName} numberOfLines={1}>{hostLine}</Text>
          {hostHandle ? (
            <Text style={s.hostHandle} numberOfLines={1}> {hostHandle}</Text>
          ) : null}
        </View>

        {/* Wall message */}
        <Text style={s.wallText}>
          {pending
            ? 'Your request is pending. The host must approve you before you can see event details.'
            : 'This is a private event. Request to join to see times, location, and details.'}
        </Text>

        {/* CTA */}
        {pending ? (
          <View style={[s.btn, s.btnPending]}>
            <Clock size={15} color={color.mute} />
            <Text style={[s.btnText, s.btnTextPending]}>Request sent</Text>
          </View>
        ) : (
          <Pressable
            style={({ pressed }) => [s.btn, s.btnRequest, pressed && { opacity: 0.8 }]}
            onPress={handleRequest}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Request to join this event"
          >
            {busy
              ? <ActivityIndicator size="small" color="#fff" style={{ marginRight: 4 }} />
              : <Lock size={15} color="#fff" />
            }
            <Text style={[s.btnText, s.btnTextRequest]}>
              {busy ? 'Sending…' : 'Request to Join'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    margin: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
    ...shadow.card,
  },
  cover: {
    height: 160,
    position: 'relative' as const,
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  coverFallback: {
    backgroundColor: '#E8E5DE',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  coverBadge: {
    position: 'absolute' as const,
    top: space.md,
    right: space.md,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  coverBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 0.3,
  },
  body: {
    padding: space.lg,
    gap: space.md,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 20,
  },
  hostRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    flexWrap: 'wrap' as const,
  },
  hostLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 13,
  },
  hostName: {
    ...t.small,
    color: color.ink,
    fontWeight: '600' as const,
    fontSize: 13,
    flexShrink: 1,
  },
  hostHandle: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    fontFamily: 'Courier',
  },
  wallText: {
    ...t.body,
    color: color.mute,
    fontSize: 13,
    lineHeight: 19,
  },
  btn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    marginTop: space.xs,
  },
  btnRequest: {
    backgroundColor: color.ink,
  },
  btnPending: {
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  btnText: {
    ...t.small,
    fontWeight: '700' as const,
    fontSize: 14,
  },
  btnTextRequest: {
    color: '#fff',
  },
  btnTextPending: {
    color: color.mute,
  },
});
