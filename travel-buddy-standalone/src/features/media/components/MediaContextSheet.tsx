/**
 * MediaContextSheet — the §7 context sheet for one media item (spec §7 / §40
 * `MediaContextSheet.tsx`; census-media §19, MD314).
 *
 * Opened from the contextual viewer's ••• control. It answers "what is this
 * part of?" with the §7 context graph — who captured it, the place, the event,
 * the trip, the hidden gem, the shared moment, and when — each edge exactly as
 * the server resolved and gated it for THIS viewer (`state/mediaContextGraph`).
 * The client derives no edge: a trip the viewer may not see is not in the
 * server's refs, so it is not in the sheet. Every edge that has a canonical home
 * is a link to it, and "Where was this taken?" runs the §38 search that answers
 * it at the coarse precision the server allows.
 *
 * While the refs load, the edges the projection already carries (person, place,
 * time) are shown; if the refs cannot be read, the sheet says so rather than
 * implying the item belongs to nothing else.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronRight, X } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { MediaProjection } from '../types/media.ts';
import type { PerspectiveEntryContextKind } from '../state/perspectiveViewer.ts';
import { fetchMediaContextRefs } from '../services/mediaProjection.ts';
import {
  CONTEXT_EDGE_LABEL,
  buildContextGraph,
  whereTakenHref,
  type ContextRef,
} from '../state/mediaContextGraph.ts';

export interface MediaContextSheetProps {
  visible: boolean;
  media: MediaProjection;
  entry?: { kind: PerspectiveEntryContextKind; entityId: string | null; entityLabel: string | null } | null;
  onClose: () => void;
  /** Navigate to an edge's canonical home (the caller owns the router). */
  onNavigate?: (href: string) => void;
}

type RefsState = { status: 'loading' | 'ready' | 'unreadable'; refs: ContextRef[] };

export function MediaContextSheet({ visible, media, entry = null, onClose, onNavigate }: MediaContextSheetProps) {
  const insets = useSafeAreaInsets();
  const [refs, setRefs] = useState<RefsState>({ status: 'loading', refs: [] });

  useEffect(() => {
    if (!visible || !media.id) return;
    const controller = new AbortController();
    setRefs({ status: 'loading', refs: [] });
    void fetchMediaContextRefs(media.id, { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return;
      setRefs(r.ok ? { status: 'ready', refs: r.data } : { status: 'unreadable', refs: [] });
    });
    return () => controller.abort();
  }, [visible, media.id]);

  const edges = useMemo(() => buildContextGraph({ media, refs: refs.refs, entry }), [media, refs.refs, entry]);

  const go = (href: string | null) => {
    if (!href || !onNavigate) return;
    onClose();
    onNavigate(href);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close context" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]} testID="media-context-sheet">
        <View style={styles.header}>
          <Text style={styles.title}>What this is part of</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <X size={20} color={color.onInk} strokeWidth={2} />
          </Pressable>
        </View>

        {edges.map((e) => (
          <Pressable
            key={`${e.kind}-${e.id ?? e.label}`}
            testID={`media-context-edge-${e.kind}`}
            style={styles.row}
            disabled={!e.href || !onNavigate}
            onPress={() => go(e.href)}
            accessibilityRole={e.href ? 'button' : 'text'}
          >
            <Text style={styles.edgeKind}>{CONTEXT_EDGE_LABEL[e.kind]}</Text>
            <Text style={styles.edgeLabel} numberOfLines={1}>
              {e.label}
            </Text>
            {e.href && onNavigate ? <ChevronRight size={16} color={color.faint} strokeWidth={2} /> : null}
          </Pressable>
        ))}

        {refs.status === 'unreadable' ? (
          <Text style={styles.note} testID="media-context-unreadable">
            Some of this item's context could not be read just now — it may belong to more than is shown.
          </Text>
        ) : null}

        {onNavigate ? (
          <Pressable
            style={styles.whereBtn}
            onPress={() => go(whereTakenHref(media.id))}
            accessibilityRole="button"
            testID="media-context-where-taken"
          >
            <Text style={styles.whereText}>Where was this taken?</Text>
          </Pressable>
        ) : null}

        <Text style={styles.footer}>
          Context is resolved by Portava — you only see the parts you are allowed to see, never a precise location.
        </Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: '#161614',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.lg,
    gap: space.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  title: { color: color.onInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(250,249,246,0.08)',
  },
  edgeKind: { width: 104, color: color.onInkMute, fontSize: 12, fontWeight: '700' },
  edgeLabel: { flex: 1, color: color.onInk, fontSize: 15, fontWeight: '700' },
  note: { color: color.warn, fontSize: 12, lineHeight: 17, paddingHorizontal: space.lg, marginTop: space.sm },
  whereBtn: {
    alignSelf: 'flex-start',
    marginHorizontal: space.lg,
    marginTop: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.1)',
  },
  whereText: { color: color.onInk, fontSize: 13, fontWeight: '800' },
  footer: { color: color.faint, fontSize: 11, lineHeight: 16, paddingHorizontal: space.lg, marginTop: space.md },
});
