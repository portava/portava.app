/**
 * AddToEventSheet — bottom sheet for attaching a place to one of the user's
 * upcoming events.
 *
 * Flow:
 *   1. Fetches GET /api/events/me (hosting + attending)
 *   2. Lists upcoming events; tapping one calls POST /api/events/:id/agenda-items
 *   3. "Create new event" row navigates to the event composer
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Calendar, Plus, MapPin, Check } from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens.ts';
import { listMyEvents, type EventListItem } from '../services/events.ts';
import { freshToken as freshApiToken } from '../services/apiToken.ts';
import { isSupabaseConfigured } from '../lib/supabase.ts';
import type { MapsPlace } from '../lib/maps.ts';

// ── API helpers ───────────────────────────────────────────────────────────────

const BASE = (() => {
  const domain = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  return domain.endsWith('/') ? domain.slice(0, -1) : domain;
})();

/** Return the set of event IDs that already have this placeId on their agenda. */
async function fetchAlreadyAddedEventIds(
  eventIds: string[],
  placeId: string,
): Promise<Set<string>> {
  if (!isSupabaseConfigured || eventIds.length === 0) return new Set();
  let token: string | null = null;
  try { token = await freshApiToken(); } catch { /* ignore */ }
  if (!token) return new Set();

  const results = await Promise.allSettled(
    eventIds.map((eid) =>
      fetch(`${BASE}/api/events/${eid}/agenda-items`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : Promise.resolve({ items: [] })))
        .then((json: { items?: { place_id?: string | null }[] }) => ({
          eid,
          items: json.items ?? [],
        }))
        .catch(() => ({ eid, items: [] })),
    ),
  );

  const alreadyAdded = new Set<string>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { eid, items } = r.value;
      if (items.some((item) => item.place_id === placeId)) {
        alreadyAdded.add(eid);
      }
    }
  }
  return alreadyAdded;
}

async function attachPlaceToEvent(
  eventId: string,
  place: MapsPlace & { id?: string },
): Promise<{ ok: boolean; message?: string }> {
  if (!isSupabaseConfigured) return { ok: false, message: 'Not authenticated' };
  let token: string | null = null;
  try { token = await freshApiToken(); } catch { /* ignore */ }
  if (!token) return { ok: false, message: 'Not authenticated' };

  try {
    const r = await fetch(`${BASE}/api/events/${eventId}/agenda-items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: place.name,
        locationName: [place.name, place.city].filter(Boolean).join(', '),
        ...(place.lat != null && place.lng != null
          ? { locationLat: place.lat, locationLng: place.lng }
          : {}),
        ...(place.id ? { placeId: place.id } : {}),
      }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: json.message ?? json.error ?? `HTTP ${r.status}` };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? 'Network error' };
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface AddToEventSheetProps {
  visible: boolean;
  place: (MapsPlace & { id?: string }) | null;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AddToEventSheet({ visible, place, onClose }: AddToEventSheetProps) {
  const insets = useSafeAreaInsets();

  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null); // eventId being submitted
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  // Fetch events when sheet opens; pre-populate addedIds if place.id is known
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError(null);
    setAddedIds(new Set());
    listMyEvents(30).then(async (result) => {
      if (result.ok && result.data) {
        // Filter to upcoming + open events
        const upcoming = result.data.events.filter(
          (e) => e.state === 'open' || e.state === 'draft' || e.state === 'started',
        );
        setEvents(upcoming);

        // Pre-mark events that already contain this place
        if (place?.id && upcoming.length > 0) {
          const alreadyAdded = await fetchAlreadyAddedEventIds(
            upcoming.map((e) => e.id),
            place.id,
          );
          if (alreadyAdded.size > 0) {
            setAddedIds(alreadyAdded);
          }
        }
      } else {
        setError(result.message ?? 'Could not load events');
      }
    }).catch(() => {
      setError('Could not load events');
    }).finally(() => setLoading(false));
  }, [visible, place?.id]);

  const handleSelectEvent = useCallback(async (event: EventListItem) => {
    if (!place || submitting) return;
    setSubmitting(event.id);
    const result = await attachPlaceToEvent(event.id, place);
    setSubmitting(null);
    if (result.ok) {
      setAddedIds((prev) => new Set([...prev, event.id]));
      setTimeout(() => {
        onClose();
      }, 800);
    } else {
      setError(result.message ?? 'Could not add to event');
    }
  }, [place, submitting, onClose]);

  const handleCreateEvent = useCallback(() => {
    onClose();
    router.push('/events/create' as any);
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={s.grab} />

        {/* Header */}
        <View style={s.head}>
          <Calendar size={18} color={color.signal} />
          <Text style={s.title}>Add to Event</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onClose} hitSlop={layout.hitSlop} style={s.xBtn}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        {/* Place preview */}
        {place && (
          <View style={s.preview}>
            <View style={s.previewIcon}>
              <MapPin size={16} color={color.onInk} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.previewTitle} numberOfLines={1}>{place.name}</Text>
              {place.city ? (
                <Text style={s.previewMeta} numberOfLines={1}>{place.city}</Text>
              ) : null}
            </View>
          </View>
        )}

        {error ? <Text style={s.error}>{error}</Text> : null}

        <ScrollView style={{ maxHeight: 340 }} contentContainerStyle={{ gap: space.sm }}>
          {loading ? (
            <ActivityIndicator color={color.signal} style={{ marginVertical: space.xl }} />
          ) : events.length === 0 && !loading ? (
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>
                No upcoming events. Create one to attach this place.
              </Text>
            </View>
          ) : (
            <>
              <Text style={s.sectionLabel}>Your upcoming events</Text>
              {events.map((event) => {
                const isAdded = addedIds.has(event.id);
                const isSubmitting = submitting === event.id;
                return (
                  <Pressable
                    key={event.id}
                    style={({ pressed }) => [
                      s.eventRow,
                      (isAdded) && s.eventRowAdded,
                      pressed && { opacity: layout.pressedOpacity },
                    ]}
                    onPress={() => handleSelectEvent(event)}
                    disabled={!!submitting || isAdded}
                  >
                    <View style={s.eventIcon}>
                      <Calendar size={14} color={isAdded ? color.success : color.signal} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.eventTitle} numberOfLines={1}>{event.title}</Text>
                      {event.startsAt ? (
                        <Text style={s.eventMeta} numberOfLines={1}>
                          {new Date(event.startsAt).toLocaleDateString(undefined, {
                            month: 'short', day: 'numeric', year: 'numeric',
                          })}
                          {event.city ? ` · ${event.city}` : ''}
                        </Text>
                      ) : event.city ? (
                        <Text style={s.eventMeta} numberOfLines={1}>{event.city}</Text>
                      ) : null}
                    </View>
                    {isSubmitting ? (
                      <ActivityIndicator size="small" color={color.signal} />
                    ) : isAdded ? (
                      <Check size={16} color={color.success} />
                    ) : null}
                  </Pressable>
                );
              })}
            </>
          )}

          {/* Create new event row */}
          <Pressable
            style={({ pressed }) => [s.createRow, pressed && { opacity: layout.pressedOpacity }]}
            onPress={handleCreateEvent}
          >
            <View style={s.createIcon}>
              <Plus size={14} color={color.onInk} />
            </View>
            <Text style={s.createText}>Create new event</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.lg, gap: space.md, ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.title, color: color.ink, fontSize: 18 },
  xBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
  },
  preview: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.sm,
  },
  previewIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  previewTitle: { ...t.bodyStrong, color: color.ink },
  previewMeta: { ...t.small, color: color.mute, fontSize: 11 },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  sectionLabel: {
    ...t.small, fontWeight: '700', color: color.mute,
    letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10,
  },
  eventRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  eventRowAdded: { borderColor: color.success + '60', backgroundColor: color.success + '08' },
  eventIcon: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: color.signal + '15', alignItems: 'center', justifyContent: 'center',
  },
  eventTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  eventMeta: { ...t.small, color: color.mute, fontSize: 11 },
  emptyWrap: { paddingVertical: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  createRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    borderRadius: radius.md, borderWidth: 1.5,
    borderColor: color.signal + '50', borderStyle: 'dashed',
    padding: space.md,
  },
  createIcon: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center',
  },
  createText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
});
