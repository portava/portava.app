import { StyleSheet } from 'react-native';
import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';

/** Shared look for the Trails and Trending surfaces. */
export const ds = StyleSheet.create({
  card: {
    marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 48 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },
  heading: { ...t.small, fontWeight: '700', color: color.ink, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  body: { ...t.small, color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  notice: { ...t.small, color: color.mute, padding: space.lg, textAlign: 'center' },
  warn: { ...t.small, color: color.warn },
  input: {
    marginHorizontal: space.lg, marginTop: space.md, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm,
    backgroundColor: color.paperRaised, paddingHorizontal: space.md, paddingVertical: space.sm, ...t.small, color: color.ink, minHeight: 44,
  },
  button: { marginHorizontal: space.lg, marginTop: space.md, paddingVertical: space.md, borderRadius: radius.pill, backgroundColor: color.ink, alignItems: 'center', minHeight: 44 },
  buttonText: { color: color.onInk, fontWeight: '700' },
  ghost: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, minHeight: 36, justifyContent: 'center' },
  ghostOn: { backgroundColor: color.ink, borderColor: color.ink },
  ghostText: { ...t.small, fontWeight: '600', color: color.ink },
  ghostTextOn: { color: color.onInk },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md },
  link: { ...t.small, fontWeight: '600', color: color.deep },
});
