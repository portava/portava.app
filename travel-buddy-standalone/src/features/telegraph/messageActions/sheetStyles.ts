/**
 * Telegraph WP-08 — one style sheet for the message-action sheets (edit, edit
 * history, report, ask). Values follow the long-press sheet the chat screens
 * already use (components/GroupChatScreen.tsx `las`), so the new sheets read as
 * the same family rather than four new designs.
 */
import { StyleSheet } from 'react-native';
import { radius, space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';

export const DANGER = '#EF4444';
/** Text on the fixed DANGER fill, in both schemes. */
export const ON_DANGER = '#FFFFFF';

/**
 * census T123/T124 — the sheets read the scheme's palette. Their primary
 * action (save an edit, ask, retry) is ordinary emphasis: the operational teal.
 * A selected REPORT reason is a safety choice: the attention colour. The
 * destructive action keeps its fixed red.
 */
export function useMessageActionSheet(): { palette: TelegraphPalette; sheet: ReturnType<typeof makeSheet> } {
  const { palette, styles } = useTelegraphTheme(makeSheet);
  return { palette, sheet: styles };
}

export const makeSheet = (p: TelegraphPalette) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: p.surfaceRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: 34,
    maxHeight: '85%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: p.haze, alignSelf: 'center', marginBottom: space.md },
  title: { ...t.bodyStrong, color: p.recvText, fontWeight: '700', fontSize: 15, marginBottom: 2 },
  sub: { ...t.small, color: p.mute, marginBottom: space.md },
  body: { ...t.body, color: p.recvText },
  note: { ...t.small, color: p.mute },
  error: { ...t.small, color: DANGER, marginTop: space.sm },
  center: { paddingVertical: space.xl, alignItems: 'center', justifyContent: 'center' },
  input: {
    ...t.body,
    color: p.recvText,
    borderWidth: 1,
    borderColor: p.haze,
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
    borderColor: p.haze,
    marginBottom: 6,
  },
  optionSelected: { borderColor: p.attention, backgroundColor: p.attention + '0A' },
  optionText: { ...t.body, color: p.recvText },
  optionTextSelected: { color: p.attention, fontWeight: '700' },
  primaryBtn: { marginTop: space.md, backgroundColor: p.operational, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  dangerBtn: { marginTop: space.md, backgroundColor: DANGER, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  btnDisabled: { opacity: 0.45 },
  btnLabel: { ...t.bodyStrong, color: p.operationalOn, fontWeight: '700' },
  dangerLabel: { ...t.bodyStrong, color: ON_DANGER, fontWeight: '700' },
  secondaryBtn: { paddingVertical: 10, alignItems: 'center' },
  secondaryLabel: { ...t.body, color: p.mute },
  card: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: p.haze,
    paddingVertical: space.md,
  },
  meta: { ...t.small, color: p.mute, marginBottom: 4 },
});
