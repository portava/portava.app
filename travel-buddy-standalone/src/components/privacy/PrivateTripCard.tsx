/**
 * PrivateTripCard — shared component for private / invite-only trip views.
 *
 * Rendered when the API returns a private-trip sentinel (isPrivate: true)
 * instead of the full TripDetail. Shows ONLY the minimal safe fields:
 * cover image or generic fallback, trip title, "Private Trip" badge,
 * owner display name and @handle, and a Request Access / Requested button.
 *
 * Deliberately does NOT render dates, hotel, route, members, itinerary,
 * destination details, or any other restricted field.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { CachedImage } from '../CachedImage.tsx';
import { Lock, Plane, Clock } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { requestTripAccess } from '../../services/trips.ts';

/** Minimal safe fields returned by the private-trip sentinel. */
export interface PrivateTripPreview {
  /** Discriminant — always true when this shape is returned. */
  isPrivate: true;
  id: string;
  /** Trip title — safe to expose (public-facing). */
  title: string | null;
  /** Cover image URL or null — fall back to generic private-trip cover. */
  coverImageUrl: string | null;
  /** Owner display name — safe to expose for the "organized by" line. */
  ownerDisplayName: string | null;
  /** Owner @handle — used for the subline. */
  ownerHandle: string | null;
  /** Owner user ID. */
  ownerId: string | null;
  /**
   * Join-request status for the current viewer (matches server field name):
   *   'pending' → "Requested" state (button disabled)
   *   null      → CTA "Request Access" is shown
   */
  myJoinRequestStatus: 'pending' | null;
}

interface Props {
  trip: PrivateTripPreview;
  /** Optional callback fired after a successful access request. */
  onRequestSent?: () => void;
}

export function PrivateTripCard({ trip, onRequestSent }: Props) {
  const [pending, setPending] = useState(trip.myJoinRequestStatus === 'pending');
  const [busy, setBusy] = useState(false);

  const ownerLine = trip.ownerDisplayName ?? (trip.ownerHandle ? `@${trip.ownerHandle}` : 'Unknown');
  const ownerHandle = trip.ownerHandle ? `@${trip.ownerHandle}` : null;

  async function handleRequest() {
    if (pending || busy) return;
    setBusy(true);
    try {
      const res = await requestTripAccess(trip.id);
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
        {trip.coverImageUrl != null ? (
          <CachedImage
            source={{ uri: trip.coverImageUrl }}
            style={s.coverImage}
            accessibilityLabel="Trip cover"
          />
        ) : (
          <View style={[s.coverImage, s.coverFallback]}>
            <Plane size={40} color={color.haze} />
          </View>
        )}
        {/* Private trip badge */}
        <View style={s.coverBadge}>
          <Lock size={11} color="#fff" />
          <Text style={s.coverBadgeText}>Private Trip</Text>
        </View>
      </View>

      <View style={s.body}>
        {/* Trip title */}
        <Text style={s.title} numberOfLines={2}>
          {trip.title ?? 'Private Trip'}
        </Text>

        {/* Owner info */}
        <View style={s.ownerRow}>
          <Text style={s.ownerLabel}>Organized by </Text>
          <Text style={s.ownerName} numberOfLines={1}>{ownerLine}</Text>
          {ownerHandle ? (
            <Text style={s.ownerHandle} numberOfLines={1}> {ownerHandle}</Text>
          ) : null}
        </View>

        {/* Wall message */}
        <Text style={s.wallText}>
          {pending
            ? 'Your request is pending. The trip owner must approve you before you can see trip details.'
            : 'This is a private trip. Request access to see the itinerary, dates, and members.'}
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
            accessibilityLabel="Request access to this trip"
          >
            {busy
              ? <ActivityIndicator size="small" color="#fff" style={{ marginRight: 4 }} />
              : <Lock size={15} color="#fff" />
            }
            <Text style={[s.btnText, s.btnTextRequest]}>
              {busy ? 'Sending…' : 'Request Access'}
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
  ownerRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    flexWrap: 'wrap' as const,
  },
  ownerLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 13,
  },
  ownerName: {
    ...t.small,
    color: color.ink,
    fontWeight: '600' as const,
    fontSize: 13,
    flexShrink: 1,
  },
  ownerHandle: {
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
