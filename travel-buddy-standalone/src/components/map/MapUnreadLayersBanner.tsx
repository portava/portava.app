/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; the round-16 verifier's B5): the NOW map's notice for layers the
 * gateway did not read and for an answer that is one page of several. The safety line comes first and is said as an
 * alert; the wording is features/map/layers/unreadLayersNotice.ts's.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';

import { space } from '../../theme/tokens.ts';
import { unreadLayersNotice } from '../../features/map/layers/unreadLayersNotice.ts';

export function MapUnreadLayersBanner({ unread, truncated, top = 0 }: { unread: readonly string[]; truncated: boolean; top?: number }) {
  const notice = unreadLayersNotice(unread, truncated);
  if (notice.lines.length === 0) return null;
  return (
    <View style={[s.banner, { top }, notice.safety ? s.safety : null]} pointerEvents="none" testID="map-layers-unread">
      {notice.lines.map((line, i) => (
        <View key={line} style={s.row}>
          <AlertTriangle size={12} color="#fff" />
          <Text
            style={[s.text, notice.safety && i === 0 ? s.safetyText : null]}
            testID={`map-layers-unread-line-${i}`}
            accessibilityRole={notice.safety && i === 0 ? 'alert' : undefined}
          >
            {line}
          </Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 0,
    right: 0,
    gap: 2,
    backgroundColor: 'rgba(0,0,0,0.62)',
    paddingVertical: 6,
    paddingHorizontal: space.md,
    zIndex: 16,
  },
  safety: { backgroundColor: 'rgba(150,20,20,0.88)' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs },
  text: { color: '#fff', fontSize: 11, fontWeight: '500' },
  safetyText: { fontSize: 12, fontWeight: '700' },
});
