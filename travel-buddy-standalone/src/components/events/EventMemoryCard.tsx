/**
 * EventMemoryCard — "Save as memory" for a completed event (PLAT-F30).
 *
 * Offered once the server has completed the event, to the host, co-hosts and
 * Going attendees (lib/eventCommunity.ts `canSaveEventAsMemory`, mirroring
 * POST /api/events/:id/memory). The memory is the saver's own Passport memory;
 * saving twice returns the same one (`alreadySaved`), so the card says
 * "Saved" either way and links to the Passport. A refusal is shown as the
 * server's message, never as a saved memory.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { BookHeart, CircleCheck } from 'lucide-react-native';
import { convertEventToMemory, type EventDetail } from '../../services/events.ts';
import { canSaveEventAsMemory } from '../../lib/eventCommunity.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  event: Pick<EventDetail, 'id' | 'state' | 'isHost' | 'myRole' | 'myRsvp'>;
}

export function EventMemoryCard({ event }: Props) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canSaveEventAsMemory(event)) return null;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await convertEventToMemory(event.id);
    setBusy(false);
    if (res.ok && res.data?.memoryId) { setSaved(true); return; }
    setError(res.message ?? 'The memory was not saved. Please try again.');
  }

  return (
    <View style={s.card} testID="event-memory-card">
      <View style={s.row}>
        {saved ? <CircleCheck size={18} color={color.success} /> : <BookHeart size={18} color={color.deep} />}
        <View style={{ flex: 1 }}>
          <Text style={s.title}>{saved ? 'Saved to your Passport' : 'Keep this event'}</Text>
          <Text style={s.sub}>{saved ? 'It is one of your memories now.' : 'Save it as a memory in your Passport.'}</Text>
        </View>
        {saved ? (
          <Pressable style={s.ghostBtn} onPress={() => router.push('/(tabs)/passport' as any)} accessibilityRole="button" accessibilityLabel="View in Passport">
            <Text style={s.ghostText}>View</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[s.btn, busy && { opacity: 0.6 }]}
            onPress={save}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Save as memory"
            testID="event-memory-save"
          >
            {busy ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={s.btnText}>Save</Text>}
          </Pressable>
        )}
      </View>
      {error ? <Text style={s.error} testID="event-memory-error">{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card:     { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm },
  row:      { flexDirection: 'row', alignItems: 'center', gap: space.md },
  title:    { ...t.body, color: color.ink, fontWeight: '700' },
  sub:      { ...t.small, color: color.mute },
  btn:      { backgroundColor: color.deep, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm, minWidth: 72, alignItems: 'center' },
  btnText:  { ...t.small, color: color.onInk, fontWeight: '700' },
  ghostBtn: { borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.sm },
  ghostText:{ ...t.small, color: color.ink, fontWeight: '700' },
  error:    { ...t.small, color: '#DC2626' },
});
