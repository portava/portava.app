/**
 * DiscoveryOutputKindsRail — one strip for one of `01` §4's three output kinds
 * PDE ranks and nothing on the client asked for: Trails, Shared Moments and
 * emerging discoveries (census-discovery §94, lane W11-X2; §91.7 item 2; DC-01).
 *
 * GATED ON THE SERVER'S OWN FLAG. `discovery_output_kinds_enabled` (3483,
 * seeded FALSE) is read through FeatureFlagsContext, which fails soft to OFF.
 * With it off — or the viewer signed out, or emerging discoveries asked for
 * with no destination — the rail renders nothing and sends NO request, so the
 * For You tab is byte-identical to before (DiscoveryOutputKindsRail.component
 * test O1/O2).
 *
 * WHAT IT SAYS. The server's page in the server's order. An empty page renders
 * nothing: absence is not an error. A failed read (`unavailable`, the route's
 * 503) is never that silence: it gets the browse list's no-rows sentence from
 * register D-W10-S1-2 ("Some trails couldn’t be loaded just now" / "This is on
 * our side, not your filters…"), the same rule DiscoveryEventPostsRail follows.
 * A transport failure, a 404 (flag off at the server) and a sign-out render
 * nothing, as the event rail's transport failure does.
 *
 * READ-ONLY CARDS. The client has no Trail or emerging-place screen to open, so
 * a card names the item and does not navigate (register D-W11X2-6).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';
import {
  getOutputKindRecommendations, outputKindItemLabel, outputKindItemId,
  type OutputKind, type OutputKindItem,
} from '../../services/discoveryRecommendations.ts';
import { listPartialEmptyTitle, LIST_PARTIAL_EMPTY_BODY } from '../../services/discoveryCoverageNotice.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

/** The server's flag, read by name (api-server migration 3483). */
export const DISCOVERY_OUTPUT_KINDS_FLAG = 'discovery_output_kinds_enabled';

const TITLE: Record<OutputKind, string> = {
  trails: 'Trails for you',
  shared_moments: 'Your shared moments',
  emerging_discoveries: 'Emerging nearby',
};
const NOUN: Record<OutputKind, string> = {
  trails: 'trails',
  shared_moments: 'shared moments',
  emerging_discoveries: 'emerging places',
};

interface Props {
  kind: OutputKind;
  destination: string | null;
  /** The viewer is signed in: every order this route serves is the viewer's own. */
  enabled: boolean;
}

export function DiscoveryOutputKindsRail({ kind, destination, enabled }: Props) {
  const flagOn = useFeatureFlags().isEnabled(DISCOVERY_OUTPUT_KINDS_FLAG);
  const active = enabled && flagOn && (kind !== 'emerging_discoveries' || !!destination);
  const [items, setItems] = useState<OutputKindItem[]>([]);
  const [failed, setFailed] = useState(false);
  const loadIdRef = useRef(0);

  useEffect(() => {
    if (!active) { setItems([]); setFailed(false); return; }
    const myId = ++loadIdRef.current;
    let cancelled = false;
    getOutputKindRecommendations(kind, { destination })
      .then((r) => {
        if (cancelled || loadIdRef.current !== myId) return;
        if (r.ok) { setItems(r.items); setFailed(false); return; }
        setItems([]);
        setFailed(r.reason === 'unavailable');
      })
      .catch(() => { if (!cancelled && loadIdRef.current === myId) { setItems([]); setFailed(false); } });
    return () => { cancelled = true; };
  }, [active, kind, destination]);

  if (!active) return null;

  if (failed) {
    return (
      <View style={styles.section} testID={`discovery-output-kind-${kind}-unavailable`}>
        <View style={styles.header}>
          <Sparkles size={14} color={color.faint} />
          <Text style={styles.title}>{TITLE[kind]}</Text>
        </View>
        <Text style={styles.noticeText}>{listPartialEmptyTitle(NOUN[kind])}</Text>
        <Text style={styles.noticeText}>{LIST_PARTIAL_EMPTY_BODY}</Text>
      </View>
    );
  }

  if (items.length === 0) return null;

  return (
    <View style={styles.section} testID={`discovery-output-kind-${kind}`}>
      <View style={styles.header}>
        <Sparkles size={14} color={color.signal} />
        <Text style={styles.title}>{TITLE[kind]}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {items.map((item) => {
          const id = outputKindItemId(kind, item);
          return (
            <View key={id} style={styles.card} testID={`discovery-output-kind-item-${id}`}>
              <Text style={styles.cardTitle} numberOfLines={2}>{outputKindItemLabel(kind, item) ?? ''}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.lg, marginBottom: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  rail: { paddingHorizontal: space.lg, paddingRight: space.md, gap: space.sm },
  card: { width: 160, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  cardTitle: { ...t.small, color: color.ink },
  noticeText: { ...t.small, color: color.mute, paddingHorizontal: space.lg, lineHeight: 19 },
});

export default DiscoveryOutputKindsRail;
