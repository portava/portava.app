/**
 * Archived Highlights — /highlights/archived
 *
 * Highlights/Memories Development Architecture Spec v1 §21:
 *   "Delete, archive, do-not-resurface, and 'keep but do not personalize' are
 *    different operations and must remain separate in both data model and UX."
 *   Archive: "Retain canonical Memory; remove from normal browsing unless
 *    EXPLICITLY REQUESTED."
 *
 * This screen is the explicit request. `GET /highlights/archived` is the only
 * read on the Highlights surface that returns archived rows, and it had no
 * client at all — so an owner who archived a Highlight would have had no way
 * back to it, which makes Archive a delete wearing a softer word.
 *
 * ── TWO THINGS IT REFUSES TO DO ────────────────────────────────────────────
 *
 * 1. IT DOES NOT REPORT A FAILED READ AS AN EMPTY ARCHIVE. The route refuses
 *    with `degraded_unavailable` rather than serving an empty list, for exactly
 *    this screen's benefit: "you have archived nothing" is a claim about
 *    somebody's retained record, and printing it for an outage tells them their
 *    archive was lost. The refusal is rendered as itself, with a retry.
 *
 * 2. IT DOES NOT OFFER DELETE. Un-archive is the action here. Collapsing the
 *    two on one screen is the §21 sentence above, undone.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Archive, RotateCcw } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { DisplayMediaImage } from '../../src/components/ui/DisplayMediaImage';
import {
  fetchArchivedHighlights,
  unarchiveHighlight,
  type Highlight,
  type HighlightErrorKind,
} from '../../src/services/highlights';

/**
 * What the owner is told, per refusal reason. `degraded_unavailable` is the
 * server's own word for "the read could not be performed" and is retryable;
 * it is deliberately not folded into a generic failure, because the retry is
 * worth offering for that one and misleading for `unauthenticated`.
 */
function messageFor(kind: HighlightErrorKind | undefined, message?: string): string {
  switch (kind) {
    case 'degraded_unavailable':
      return 'We couldn’t load your archived highlights. Please try again in a moment.';
    case 'network_unreachable':
      return 'You appear to be offline, so we couldn’t check your archive.';
    case 'unauthenticated':
      return 'Please sign in again to see your archive.';
    case 'config_error':
      return 'Your archive isn’t available on this build.';
    default:
      return message ?? 'We couldn’t load your archived highlights.';
  }
}

export default function ArchivedHighlightsScreen() {
  const insets = useSafeAreaInsets();
  const [highlights, setHighlights] = useState<Highlight[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fetchArchivedHighlights();
    setLoading(false);
    if (!r.ok || !r.data) {
      // NOT `setHighlights([])`. See the header: an outage must not print as
      // an empty archive.
      setHighlights(null);
      setError(messageFor(r.errorKind, r.message));
      return;
    }
    setHighlights(r.data);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const restore = useCallback(async (id: string) => {
    setBusyId(id);
    const r = await unarchiveHighlight(id);
    setBusyId(null);
    if (!r.ok) {
      Alert.alert('Not restored', messageFor(r.errorKind, r.message));
      return;
    }
    // The row leaves this list because the server accepted the write, not
    // because it was tapped.
    setHighlights((prev) => (prev ?? []).filter((h) => h.id !== id));
  }, []);

  return (
    <View style={s.screen}>
      <View style={[s.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Archived highlights</Text>
        <View style={s.spacer} />
      </View>

      {loading ? (
        <View style={s.pad} testID="archived-highlights-loading">
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      ) : error ? (
        <View style={s.pad} testID="archived-highlights-unavailable">
          <Text style={s.notice}>{error}</Text>
          <Pressable onPress={() => void load()} style={s.retry} accessibilityRole="button" testID="archived-highlights-retry">
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (highlights ?? []).length === 0 ? (
        <View style={s.pad} testID="archived-highlights-empty">
          <Archive size={22} color={color.mute} />
          <Text style={s.notice}>Nothing archived. Archived highlights stay here until you restore them.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.list} testID="archived-highlights-list">
          {(highlights ?? []).map((h) => (
            <View key={h.id} style={s.row} testID={`archived-highlight-${h.id}`}>
              <DisplayMediaImage
                uri={h.mediaUrl}
                width={56}
                height={56}
                style={s.thumb}
                alt={h.caption ?? 'Archived highlight'}
              />
              <View style={s.body}>
                <Text style={s.rowTitle} numberOfLines={1}>{h.caption ?? 'Highlight'}</Text>
                <Text style={s.rowNote} numberOfLines={1}>
                  {[h.locationName, h.locationCity, h.locationCountry].filter(Boolean).join(', ') || 'No location'}
                </Text>
              </View>
              {busyId === h.id ? (
                <ActivityIndicator size="small" color={color.signal} />
              ) : (
                <Pressable
                  onPress={() => void restore(h.id)}
                  disabled={busyId !== null}
                  style={s.restore}
                  testID={`archived-highlight-restore-${h.id}`}
                  accessibilityRole="button"
                  accessibilityLabel="Restore this highlight"
                >
                  <RotateCcw size={16} color={color.ink} />
                  <Text style={s.restoreText}>Restore</Text>
                </Pressable>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.md,
  },
  title: { ...t.bodyStrong, color: color.ink },
  spacer: { width: 22 },
  pad: { padding: space.xl, alignItems: 'center', gap: space.md },
  notice: { ...t.body, color: color.mute, textAlign: 'center' },
  retry: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  retryText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  list: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: color.haze },
  body: { flex: 1, gap: 2 },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowNote: { ...t.small, color: color.faint, fontSize: 11 },
  restore: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
  },
  restoreText: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
});
