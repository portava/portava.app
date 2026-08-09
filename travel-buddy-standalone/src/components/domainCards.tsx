import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Sparkles, Info, MapPin, Plus, Bookmark } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, icon, layout } from '../theme/tokens.ts';
import { TravelButton } from './primitives.tsx';

/**
 * Domain cards used across Discovery / Pulse / Trip. Thin, token-driven.
 *
 * - CompassCard        : AI suggestion card. Honesty-first — takes an explicit
 *                        `reason` and optional `provisional` flag; never implies
 *                        verified ranking.
 * - ImageDiscoveryCard : image-led place/experience card with Save + Add to Plan.
 */

export function CompassCard({
  title, subtitle, reason, provisional, onDetails, onAdd,
}: {
  title: string;
  subtitle?: string;
  reason?: string;          // why suggested — shown verbatim, not a fake score
  provisional?: boolean;    // seeded data -> cautious label
  onDetails?: () => void;
  onAdd?: () => void;
}) {
  return (
    <View style={cc.card}>
      <View style={cc.media}>
        <View style={cc.label}><Sparkles size={12} color={color.onInk} /><Text style={cc.labelText}>COMPASS PICK</Text></View>
      </View>
      <View style={cc.body}>
        <Text style={cc.title}>{title}</Text>
        {subtitle ? <Text style={cc.sub}>{subtitle}</Text> : null}
        {reason ? (
          <View style={cc.reasonRow}><Info size={13} color={color.deep} /><Text style={cc.reason}>{reason}</Text></View>
        ) : null}
        {provisional ? <Text style={cc.prov}>Based on starter city notes — provisional</Text> : null}
        <View style={cc.btns}>
          {onDetails ? <TravelButton label="View Details" variant="ghost" onPress={onDetails} full /> : null}
          {onAdd ? <TravelButton label="Add to Plan" variant="primary" icon={<Plus size={15} color={color.onInk} />} onPress={onAdd} full /> : null}
        </View>
      </View>
    </View>
  );
}

export function ImageDiscoveryCard({
  name, blurb, neighborhood, width = 160, onAdd, onSave,
}: {
  name: string; blurb?: string; neighborhood?: string; width?: number;
  onAdd?: () => void; onSave?: () => void;
}) {
  return (
    <View style={[idc.card, { width }]}>
      <View style={idc.media}>
        <View style={idc.sparkle}><Sparkles size={14} color={color.onInk} /></View>
      </View>
      <View style={idc.body}>
        <Text style={idc.title} numberOfLines={1}>{name}</Text>
        {blurb ? <Text style={idc.sub} numberOfLines={1}>{blurb}</Text> : null}
        {neighborhood ? (
          <View style={idc.locRow}><MapPin size={11} color={color.mute} /><Text style={idc.loc} numberOfLines={1}>{neighborhood}</Text></View>
        ) : null}
        <View style={idc.btnRow}>
          <Pressable style={({ pressed }) => [idc.addBtn, pressed && { opacity: layout.pressedOpacity }]} onPress={onAdd}>
            <Text style={idc.addText}>Add to Plan</Text>
          </Pressable>
          <Pressable onPress={onSave} hitSlop={layout.hitSlop}><Bookmark size={16} color={color.mute} /></Pressable>
        </View>
      </View>
    </View>
  );
}

const cc = StyleSheet.create({
  card: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.ink, ...shadow.card },
  media: { height: 90, backgroundColor: color.deep, padding: space.md },
  label: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: color.signal, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  labelText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
  body: { padding: space.md, gap: 5 },
  title: { ...t.title, color: color.onInk, fontSize: 19 },
  sub: { ...t.small, color: color.haze },
  reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.12)', alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.sm },
  reason: { ...t.small, color: color.onInk, fontSize: 11 },
  prov: { ...t.small, color: color.onInkMute, fontSize: 10, fontStyle: 'italic' },
  btns: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
});

const idc = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card },
  media: { height: 110, backgroundColor: color.deep, padding: space.sm },
  sparkle: { width: icon.s26, height: icon.s26, borderRadius: icon.s26 / 2, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: 3 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  sub: { ...t.small, color: color.mute, fontSize: 11 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  loc: { ...t.small, color: color.mute, fontSize: 11 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  addBtn: { flex: 1, borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.sm, paddingVertical: 6, alignItems: 'center' },
  addText: { ...t.small, fontWeight: '800', color: color.signal, fontSize: 12 },
});

/* Re-exports so all spec-named primitives resolve from one import site. */
export { AvailabilityCard as AvailabilityStatusCard } from './AvailabilityCard.tsx';
export { TrustChip } from './PassportSections.tsx';
export { PassportStampCard } from './PassportStampCard.tsx';
export { PassportInkStamp, PassportHeroBackdrop } from './PassportMarks.tsx';
export { PostcardTile } from './PostcardTile.tsx';
