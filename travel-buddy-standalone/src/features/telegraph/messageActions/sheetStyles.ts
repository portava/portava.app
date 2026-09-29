/**
 * Telegraph WP-08 — one style sheet for the message-action sheets (edit, edit
 * history, report, ask). Values follow the long-press sheet the chat screens
 * already use (components/GroupChatScreen.tsx `las`), so the new sheets read as
 * the same family rather than four new designs.
 */
import { StyleSheet } from 'react-native';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';

export const DANGER = '#EF4444';

export const sheet = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: 34,
    maxHeight: '85%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 15, marginBottom: 2 },
  sub: { ...t.small, color: color.mute, marginBottom: space.md },
  body: { ...t.body, color: color.ink },
  note: { ...t.small, color: color.mute },
  error: { ...t.small, color: DANGER, marginTop: space.sm },
  center: { paddingVertical: space.xl, alignItems: 'center', justifyContent: 'center' },
  input: {
    ...t.body,
    color: color.ink,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.sm,
    paddingVertical: 10,
    minHeight: 44,
    textAlignVertical: 'top',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: 6,
  },
  optionSelected: { borderColor: color.signal, backgroundColor: color.signal + '0A' },
  optionText: { ...t.body, color: color.ink },
  optionTextSelected: { color: color.signal, fontWeight: '700' },
  primaryBtn: { marginTop: space.md, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  dangerBtn: { marginTop: space.md, backgroundColor: DANGER, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  btnDisabled: { opacity: 0.45 },
  btnLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  secondaryBtn: { paddingVertical: 10, alignItems: 'center' },
  secondaryLabel: { ...t.body, color: color.mute },
  card: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
    paddingVertical: space.md,
  },
  meta: { ...t.small, color: color.mute, marginBottom: 4 },
});
