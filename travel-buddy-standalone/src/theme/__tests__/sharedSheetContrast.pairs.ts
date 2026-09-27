/**
 * The shared sheets Media opens, measured as they render when opened from
 * Media (census-media §33, the owner's H7 ruling of 2026-09-27: "Include
 * comments, share, place picker, and plan picker in Media's contrast
 * requirement").
 *
 * Data only — no test() here. Two suites read it:
 *   - src/features/media/__tests__/mediaContrast.test.ts asserts every pair as
 *     one of Media's own (§46, WCAG AA: text 4.5:1, state marks 3:1), with the
 *     needles below tying each colour to its source line;
 *   - src/theme/__tests__/sharedSheetContrast.consumers.test.ts is the
 *     design-system regression guard: it measures every pair BEFORE and AFTER
 *     §33 on every consumer's ground, enumerates every consumer of each changed
 *     component and token from the source tree, and fails if a pair got worse
 *     or ended below AA.
 *
 * The five sheets and the shared components drawn inside their own layouts:
 *   CommentsSheet (via MediaCommentSheet: Watch, Gems, the Grid viewer) with
 *     RichText, TranslationToggle, VerifiedStamp, StampIcon, MentionInput and
 *     MentionSuggestionList;
 *   ShareSheet (Watch; the World shell's Telegraph share) with PortavaSheet,
 *     SectionHeader and Avatar;
 *   GlobalPlacePicker (the add-gem sheet);
 *   PlanPickerController (the World action rail, Route It, the Watch list) with
 *     DatePickerField and LockTypeSelector;
 *   DisambiguationSheet (CreationAssist's "See all" in the add-gem sheet) with
 *     EntitySuggestionRow.
 *
 * `was` / `wasOn` record the colour and ground at e9e0b0404, before §33. A pair
 * with neither is unchanged by §33 and is measured so the whole render is
 * graded, not only what moved.
 *
 * Kinds, as in mediaContrast.test.ts: `text` 4.5:1; `ui` 3:1 for a state mark
 * or an icon-only control; `decor` measured and printed, never asserted — an
 * icon beside the label that names it (§31.13.8 (c)), a field or button
 * outline its label or placeholder identifies, a disabled control (1.4.3), a
 * backdrop. Plain-View drag handles carry no state and name no control and are
 * not paired, as §31 did not pair the Media sheets' own.
 */
import { color } from '../tokens.ts';

export type Needle = readonly [file: string, needle: string | RegExp];
export type Kind = 'text' | 'ui' | 'decor';

/** `color.signal + 'AA'` (an 8-digit hex the source builds) as the rgba() the contrast helpers read. */
export function hexA(hex: string, alphaHex: string): string {
  const n = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!n || !/^[0-9a-f]{2}$/i.test(alphaHex)) throw new Error(`hexA: ${hex} ${alphaHex}`);
  const v = n[1];
  return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${parseInt(alphaHex, 16) / 255})`;
}

/** The opaque pixel a colour makes at `opacity` over `ground` — a whole control drawn at reduced opacity. */
export function atOpacity(hex: string, opacity: number, ground: string): string {
  const p = (h: string) => { const n = /^#([0-9a-f]{6})$/i.exec(h); if (!n) throw new Error(`atOpacity: ${h}`); return [0, 2, 4].map((i) => parseInt(n[1].slice(i, i + 2), 16)); };
  const [f, g] = [p(hex), p(ground)];
  return `rgba(${f.map((c, i) => c * opacity + g[i] * (1 - opacity)).join(',')},1)`;
}

/** Files, relative to the standalone app root. */
export const SF = {
  comments: 'src/components/CommentsSheet.tsx',
  mediaComments: 'src/components/media/MediaCommentSheet.tsx',
  richText: 'src/components/RichText.tsx',
  translation: 'src/components/TranslationToggle.tsx',
  verified: 'src/components/ui/VerifiedStamp.tsx',
  stampIcon: 'src/components/stamps/StampIcon.tsx',
  mentionInput: 'src/components/MentionInput.tsx',
  mentionList: 'src/components/MentionSuggestionList.tsx',
  share: 'src/components/ShareSheet.tsx',
  portavaSheet: 'src/components/ui/PortavaSheet.tsx',
  sectionHeader: 'src/components/ui/SectionHeader.tsx',
  avatar: 'src/components/ui/Avatar.tsx',
  placePicker: 'src/components/selectors/GlobalPlacePicker.tsx',
  planPicker: 'src/components/PlanPickerController.tsx',
  dateField: 'src/components/DateTimePickerField.tsx',
  lockType: 'src/components/itinerary/LockTypeSelector.tsx',
  disambiguation: 'src/platform/input-assistance/components/DisambiguationSheet.tsx',
  entityRow: 'src/platform/input-assistance/components/EntitySuggestionRow.tsx',
  tokens: 'src/theme/tokens.ts',
} as const;

/** Grounds, bottom-first; translucent layers are composited onto what is beneath them. */
export const SHEET_SURFACES = {
  sheetPaper: [color.paper],
  sheetPaperRaised: [color.paperRaised],
  sheetWhite: ['#FFFFFF'],
  sheetHaze: [color.haze],
  sheetDeep: [color.deep],
  sheetInk: [color.ink],
  sheetSignal: [color.signal],
  sheetSignalStrong: [color.signalStrong],
  sheetTealTint: ['#E2EDF0'],
  sheetShareBlueTint: ['#EEF1FF'],
  sheetShareGreenTint: ['#EDF7EE'],
  sheetShareOrangeTint: ['#FFF3EE'],
  /** ShareSheet "New Telegraph" row: signal at 0x07 on the sheet. */
  sheetPrSignal07: [color.paperRaised, hexA(color.signal, '07')],
  /** …and its icon disc, signal at 0x15 on that row. */
  sheetPrSignal07Signal15: [color.paperRaised, hexA(color.signal, '07'), hexA(color.signal, '15')],
  /** ShareSheet selected thread row: signal at 0x0A. */
  sheetPrSignal0A: [color.paperRaised, hexA(color.signal, '0A')],
  /** ShareSheet "Send" badge and MentionSuggestionList's hashtag chip and icon: signal at 0x15 on paperRaised. */
  sheetPrSignal15: [color.paperRaised, hexA(color.signal, '15')],
  /** PlanPicker's selected-trip chip: signal at 0x12 on the paper sheet. */
  sheetPSignal12: [color.paper, hexA(color.signal, '12')],
  /** GlobalPlacePicker's custom and "near" icon discs: signal at 0x15 on the paper sheet. */
  sheetPSignal15: [color.paper, hexA(color.signal, '15')],
  /** GlobalPlacePicker's GPS icon disc: signal at 0x20 on the paper sheet. */
  sheetPSignal20: [color.paper, hexA(color.signal, '20')],
  /** ShareSheet's Send button while disabled (`opacity: 0.45` on the sheet): its fill, now and before §33. */
  sheetShareSendDisabled: [atOpacity(color.signalStrong, 0.45, color.paperRaised)],
  sheetShareSendDisabledWas: [atOpacity(color.signal, 0.45, color.paperRaised)],
  /** PlanPicker's confirm button while submitting (`opacity: 0.6` on the sheet): its fill, now and before §33. */
  sheetPlanConfirmSubmitting: [atOpacity(color.signalStrong, 0.6, color.paper)],
  sheetPlanConfirmSubmittingWas: [atOpacity(color.signal, 0.6, color.paper)],
} as const satisfies Record<string, readonly string[]>;
export type SheetSurface = keyof typeof SHEET_SURFACES;

export interface SheetPair {
  /** Unique within this module; mediaContrast.test.ts prefixes `sheets.`. */
  id: string;
  fg: string;
  on: SheetSurface;
  kind: Kind;
  at: readonly Needle[];
  /** The fg at e9e0b0404, when §33 changed it. */
  was?: string;
  /** The ground at e9e0b0404, when §33 changed it. */
  wasOn?: SheetSurface;
  /** CommentsSheet only: drawn on the comment list's ground (paperRaised in the sheet, paper in CommentsSection on the post screen). */
  list?: true;
}

const P: SheetPair[] = [];
const add = (p: SheetPair) => P.push(p);

// ═══ CommentsSheet — opened from Media through MediaCommentSheet ═══════════════
const CS = SF.comments;
const CS_SHEET: Needle = [CS, /sheet: \{[^}]*backgroundColor: color\.paperRaised,/];
const CS_OPENED: Needle = [SF.mediaComments, '<CommentsSheet'];
// Chrome.
add({ id: 'comments.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [CS_OPENED, CS_SHEET, [CS, "title: { fontSize: 16, fontWeight: '700', color: color.ink },"]] });
add({ id: 'comments.close', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [CS_SHEET, [CS, '<X size={20} color={color.ink} />']] });
add({ id: 'comments.handle', fg: color.haze, on: 'sheetPaperRaised', kind: 'decor', at: [CS_SHEET, [CS, /handleBar: \{[^}]*backgroundColor: color\.haze,/], [CS, "hitSlop={14}\n            accessible={false}"]] }); // a grabber hidden from assistive tech; the header's X closes, and scrolling to the top collapses
add({ id: 'comments.loading', fg: color.signal, on: 'sheetPaperRaised', kind: 'ui', at: [CS_SHEET, [CS, '<ActivityIndicator color={color.signal} />']] });
add({ id: 'comments.empty', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', at: [CS_SHEET, [CS, "empty: { fontSize: 14, color: color.mute, textAlign: 'center', paddingHorizontal: space.xl },"]] });
// A comment and a reply, on the list ground.
add({ id: 'comments.author', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', list: true, at: [CS_SHEET, [CS, "commentAuthor: { fontSize: 13, fontWeight: '700', color: color.ink },"]] });
add({ id: 'comments.time', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', list: true, at: [CS_SHEET, [CS, 'commentTime: { fontSize: 11, color: color.mute },']] });
add({ id: 'comments.edited', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', list: true, at: [CS_SHEET, [CS, "editedLabel: { fontSize: 10, color: color.mute, fontStyle: 'italic' },"]] });
add({ id: 'comments.body', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', list: true, at: [CS_SHEET, [CS, 'commentText: { fontSize: 14, color: color.ink, lineHeight: 20 },']] });
// One needle per call site — a comment's body and a reply's — so reverting either one is caught.
const MENTION: Needle[] = [
  [CS, /content=\{commentTx\.translated(?:(?!\/>)[\s\S])*?style=\{s\.commentText\} mentionColor=\{color\.signalStrong\}\n\s*\/>/],
  [CS, /content=\{reply\.body\}(?:(?!\/>)[\s\S])*?style=\{s\.commentText\} mentionColor=\{color\.signalStrong\}\n\s*\/>/],
  [SF.richText, 'style={[_s.mention, mentionColor ? { color: mentionColor } : null]}'],
];
add({ id: 'comments.mention', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', list: true, at: [CS_SHEET, ...MENTION] });
add({ id: 'comments.hashtag', fg: color.deep, on: 'sheetPaperRaised', kind: 'text', list: true, at: [CS_SHEET, [SF.richText, "hashtag: { color: color.deep,   fontWeight: '600' },"]] });
const TX: Needle = [CS, '<TranslationToggle tx={commentTx} />'];
add({ id: 'comments.translation.label', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', list: true, at: [TX, [SF.translation, /labelText: \{\s*\.\.\.typography\.caption,\s*color: color\.mute,/]] });
add({ id: 'comments.translation.toggle', fg: color.deep, on: 'sheetPaperRaised', kind: 'text', list: true, at: [TX, [SF.translation, /toggleText: \{\s*\.\.\.typography\.caption,\s*color: color\.deep,/]] });
add({ id: 'comments.translation.spinner', fg: color.faint, on: 'sheetPaperRaised', kind: 'decor', list: true, at: [TX, [SF.translation, '<ActivityIndicator size="small" color={color.faint} />\n        <Text style={styles.labelText}> Translating…</Text>']] }); // beside its own "Translating…" label
add({ id: 'comments.replyButton', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', list: true, at: [CS_SHEET, [CS, "replyBtnText: { fontSize: 12, fontWeight: '600', color: color.mute },"]] });
add({ id: 'comments.like.idle', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'ui', list: true, at: [[CS, '<StampIcon size={13} active={likedByMe} color={likedByMe ? color.signal : color.mute} />'], [CS, '<StampIcon size={12} active={likedByMe} color={likedByMe ? color.signal : color.mute} />']] });
add({ id: 'comments.like.active', fg: color.signal, on: 'sheetPaperRaised', kind: 'ui', list: true, at: [[CS, '<StampIcon size={13} active={likedByMe} color={likedByMe ? color.signal : color.mute} />'], [SF.stampIcon, 'const c = colorProp ?? (active ? tokens.signal : tokens.mute);']] });
add({ id: 'comments.likeCount.idle', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', list: true, at: [[CS, "likeCount: { fontSize: 10, fontWeight: '700', color: color.mute },"]] });
add({ id: 'comments.likeCount.active', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', list: true, at: [[CS, 'likeCountActive: { color: color.signalStrong },'], [CS, '<Text style={[s.likeCount, likedByMe && s.likeCountActive]}>{likeCount}</Text>']] });
add({ id: 'comments.delete', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'ui', list: true, at: [[CS, '<Trash2 size={13} color={color.mute} />'], [CS, '<Trash2 size={12} color={color.mute} />']] });
add({ id: 'comments.replyEdit', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'ui', list: true, at: [[CS, '<Pencil size={12} color={color.mute} />']] });
add({ id: 'comments.replyArrow', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'ui', list: true, at: [[CS, '<CornerDownRight size={12} color={color.mute} style={s.replyIcon} />']] });
add({ id: 'comments.repliesToggle', fg: color.deep, on: 'sheetPaperRaised', kind: 'text', list: true, at: [[CS, "repliesToggleText: { fontSize: 12, fontWeight: '600', color: color.deep },"]] });
add({ id: 'comments.repliesLoading', fg: color.signal, on: 'sheetPaperRaised', kind: 'ui', list: true, at: [[CS, '<ActivityIndicator size="small" color={color.signal} />']] });
add({ id: 'comments.repliesEmpty', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', list: true, at: [[CS, 'repliesEmptyText: { marginLeft: 44, fontSize: 12, color: color.mute },']] });
add({ id: 'comments.verified', fg: '#1A3A5C', on: 'sheetPaperRaised', kind: 'ui', list: true, at: [[CS, '{comment.author.verified ? <VerifiedStamp size="sm" /> : null}'], [SF.verified, "const ink = dark ? 'rgba(250,249,246,0.92)' : '#1A3A5C';"]] });
add({ id: 'comments.inlineCancel', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', list: true, at: [[CS, "inlineEditBtnText: { fontSize: 12, fontWeight: '600', color: color.mute },"]] });
add({ id: 'comments.inlineButtonOutline', fg: color.haze, on: 'sheetPaperRaised', kind: 'decor', list: true, at: [[CS, /inlineEditBtn: \{[^}]*borderColor: color\.haze,/]] }); // "Save" / "Cancel" name each button
// Grounds a comment row paints itself.
add({ id: 'comments.avatarInitials', fg: color.onInk, on: 'sheetDeep', kind: 'text', at: [[CS, "<Text style={{ fontSize: size * 0.38, fontWeight: '700', color: color.onInk }}>{initials}</Text>"], [CS, 'borderRadius: size / 2, backgroundColor: color.deep,']] });
const EDIT_INPUT: Needle = [CS, /inlineEditInput: \{[^}]*color: color\.ink,\s*backgroundColor: color\.paper,/];
add({ id: 'comments.inlineEdit.text', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [EDIT_INPUT] });
add({ id: 'comments.inlineEdit.outline', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [EDIT_INPUT, [CS, /inlineEditInput: \{\s*borderWidth: 1\.5,\s*borderColor: color\.haze,/]] }); // the comment's own text fills it, and Save/Cancel sit under it
const SAVE: Needle = [CS, 'inlineEditBtnSave: { backgroundColor: color.signalStrong, borderColor: color.signalStrong },'];
add({ id: 'comments.inlineSave.label', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [SAVE, [CS, "inlineEditBtnSaveText: { fontSize: 12, fontWeight: '700', color: color.onInk },"]] });
add({ id: 'comments.inlineSave.spinner', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'ui', at: [SAVE, [CS, '? <ActivityIndicator size="small" color={color.onInk} />\n                      : <Text style={s.inlineEditBtnSaveText}>Save</Text>}']] });
add({ id: 'comments.disabledBanner', fg: color.muteStrong, was: color.mute, on: 'sheetHaze', kind: 'text', at: [[CS, /disabledBanner: \{\s*backgroundColor: color\.haze,/], [CS, "disabledText: { fontSize: 13, color: color.muteStrong, fontStyle: 'italic' },"]] });
const REPLY_CTX: Needle = [CS, /replyContext: \{[^}]*backgroundColor: color\.paper,/];
add({ id: 'comments.replyContext.text', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [REPLY_CTX, [CS, "replyContextText: { fontSize: 12, color: color.mute, fontStyle: 'italic', flex: 1, marginRight: space.sm },"]] });
// The sheet's own JSX (CommentsSection repeats it one indent deeper; the guard anchors that copy separately).
add({ id: 'comments.replyContext.close', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'ui', at: [REPLY_CTX, [CS, '\n              <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>\n                <X size={14} color={color.mute} />']] });
const INPUT: Needle = [CS, /input: \{[^}]*color: color\.ink,\s*backgroundColor: color\.paper,/];
add({ id: 'comments.input.text', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [INPUT] });
add({ id: 'comments.input.placeholder', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [INPUT, [CS, '\n                placeholder={inputPlaceholder}\n                placeholderTextColor={color.mute}']] });
add({ id: 'comments.input.outline', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [INPUT, [CS, /input: \{[^}]*borderColor: color\.haze,/]] }); // its placeholder names it
add({ id: 'comments.capWarning', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', list: true, at: [[CS, '<MentionInput'], [SF.mentionInput, /capWarning: \{\s*\.\.\.t\.small,\s*color: color\.signalStrong,/]] });
const SEND: Needle = [CS, "sendBtn: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },"];
add({ id: 'comments.send.icon', fg: color.onInk, on: 'sheetSignal', kind: 'ui', at: [SEND, [CS, '<SendHorizonal size={18} color={color.onInk} />']] }); // icon-only: 3:1, and the brand fill clears it
add({ id: 'comments.send.spinner', fg: color.onInk, on: 'sheetSignal', kind: 'ui', at: [SEND, [CS, '<ActivityIndicator size="small" color={color.onInk} />\n                ) : (\n                  <SendHorizonal size={18} color={color.onInk} />']] });
add({ id: 'comments.send.disabled', fg: color.onInk, on: 'sheetHaze', kind: 'decor', at: [[CS, 'sendBtnDisabled: { backgroundColor: color.haze },']] }); // disabled until there is text (1.4.3)
// MentionSuggestionList, above the input, on its own paperRaised panel.
const ML = SF.mentionList;
const ML_PANEL: Needle = [ML, /container: \{\s*backgroundColor: color\.paperRaised,/];
add({ id: 'comments.mentions.name', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [[CS, '<MentionSuggestionList'], ML_PANEL, [ML, /rowName: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.ink,/]] });
add({ id: 'comments.mentions.sub', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [ML_PANEL, [ML, /rowSub: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'comments.mentions.empty', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [ML_PANEL, [ML, /emptyText: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'comments.mentions.loading', fg: color.mute, on: 'sheetPaperRaised', kind: 'ui', at: [ML_PANEL, [ML, '<ActivityIndicator size="small" color={color.mute} />']] });
add({ id: 'comments.mentions.typeChip', fg: color.onInk, on: 'sheetInk', kind: 'text', at: [[ML, /chip: \{[^}]*backgroundColor: color\.ink,/], [ML, /chipText: \{[^}]*color: color\.onInk,/]] });
add({ id: 'comments.mentions.typeIcon', fg: color.onInk, on: 'sheetInk', kind: 'decor', at: [[ML, 'const iconColor = color.onInk;'], [ML, /avatarFallback: \{\s*backgroundColor: color\.ink,/]] }); // beside the chip's type label
add({ id: 'comments.mentions.hashtagChip', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal15', kind: 'text', at: [ML_PANEL, [ML, '<Text style={[styles.chipText, { color: color.signalStrong }]}>Hashtag</Text>'], [ML, /hashtagChip: \{\s*backgroundColor: `\$\{color\.signal\}15`,/]] });
add({ id: 'comments.mentions.hashtagIcon', fg: color.signal, on: 'sheetPrSignal15', kind: 'decor', at: [[ML, '<Hash size={14} color={color.signal} />'], [ML, /hashtagIcon: \{\s*backgroundColor: `\$\{color\.signal\}15`,/]] }); // beside "#slug" and the "Hashtag" chip

// ═══ ShareSheet — Watch's send sheet and the World shell's Telegraph share ═════
const SH = SF.share;
const SH_SHEET: Needle = [SF.portavaSheet, /sheet: \{[^}]*backgroundColor: color\.paperRaised,/];
const SH_OPENED: Needle = [SH, '<PortavaSheet'];
add({ id: 'share.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [SH_OPENED, SH_SHEET, [SH, /title: \{\s*fontSize: 16,\s*fontWeight: '700',\s*color: color\.ink,/]] });
add({ id: 'share.close', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [SH_SHEET, [SH, '<X size={20} color={color.ink} />']] });
add({ id: 'share.option.label', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [SH_SHEET, [SH, /optionLabel: \{\s*fontSize: 15,\s*fontWeight: '600',\s*color: color\.ink,/]] });
add({ id: 'share.option.sub', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', at: [SH_SHEET, [SH, /optionSub: \{\s*fontSize: 12,\s*color: color\.mute,/]] });
add({ id: 'share.option.shareIcon', fg: '#4A6CF7', on: 'sheetShareBlueTint', kind: 'decor', at: [[SH, 'iconBg="#EEF1FF"\n                icon={<PortavaShareIcon size={20} color="#4A6CF7" />}']] }); // beside "Share Post"
add({ id: 'share.option.linkIcon', fg: color.success, on: 'sheetShareGreenTint', kind: 'decor', at: [[SH, 'iconBg="#EDF7EE"\n                icon={<Link size={20} color={color.success} />}']] }); // beside "Copy Link"
add({ id: 'share.option.chatIcon', fg: '#F97316', on: 'sheetShareOrangeTint', kind: 'decor', at: [[SH, 'iconBg="#FFF3EE"\n                icon={<MessageCircle size={20} color="#F97316" />}']] }); // beside "Send in a chat"
add({ id: 'share.sectionHeader', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [[SH, '<SectionHeader>Share in app</SectionHeader>'], [SF.sectionHeader, /label: \{[^}]*color: color\.mute,/]] });
add({ id: 'share.cancel', fg: color.ink, on: 'sheetHaze', kind: 'text', at: [[SH, /cancel: \{[^}]*backgroundColor: color\.haze,/], [SH, /cancelText: \{[^}]*color: color\.ink,/]] });
// The picker.
add({ id: 'share.back', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', at: [SH_SHEET, [SH, /backText: \{\s*fontSize: 15,\s*fontWeight: '600',\s*color: color\.signalStrong,/]] });
const CAPTION: Needle = [SH, /captionInput: \{[^}]*backgroundColor: color\.paper,[^}]*color: color\.ink,/];
add({ id: 'share.caption.text', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [CAPTION] });
add({ id: 'share.caption.placeholder', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [CAPTION, [SH, 'placeholder="Add a note (optional)…"\n              placeholderTextColor={color.mute}']] });
add({ id: 'share.caption.outline', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [CAPTION] }); // its placeholder names it
add({ id: 'share.chooseLabel', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [SH_SHEET, [SH, /chooseLabel: \{[^}]*color: color\.mute,/]] });
const SEARCH: Needle = [SH, /searchRow: \{[^}]*backgroundColor: color\.paper,/];
add({ id: 'share.search.text', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [SEARCH, [SH, /searchInput: \{[^}]*color: color\.ink,/]] });
add({ id: 'share.search.placeholder', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [SEARCH, [SH, 'placeholder="Search chats or find someone…"\n                placeholderTextColor={color.mute}']] });
add({ id: 'share.search.icon', fg: color.mute, on: 'sheetPaper', kind: 'decor', at: [SEARCH, [SH, '<Search size={14} color={color.mute} style={{ flexShrink: 0 }} />']] }); // beside the placeholder
add({ id: 'share.search.clear', fg: color.mute, on: 'sheetPaper', kind: 'ui', at: [SEARCH, [SH, '<X size={13} color={color.mute} />']] });
add({ id: 'share.search.outline', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [SEARCH] });
const NEW_THREAD: Needle = [SH, "backgroundColor: color.signal + '07',"];
add({ id: 'share.newThread.label', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal07', kind: 'text', at: [NEW_THREAD, [SH, "newThreadLabel: { fontSize: 14, fontWeight: '700', color: color.signalStrong },"]] });
add({ id: 'share.newThread.sub', fg: color.mute, on: 'sheetPrSignal07', kind: 'text', at: [NEW_THREAD, [SH, 'newThreadSub: { fontSize: 11, color: color.mute, marginTop: 1 },']] });
add({ id: 'share.newThread.icon', fg: color.signal, on: 'sheetPrSignal07Signal15', kind: 'decor', at: [NEW_THREAD, [SH, "backgroundColor: color.signal + '15',"], [SH, '<PlusCircle size={16} color={color.signal} />']] }); // beside "New Telegraph"
add({ id: 'share.newThread.outline', fg: hexA(color.signal, '40'), on: 'sheetPrSignal07', kind: 'decor', at: [NEW_THREAD, [SH, "borderColor: color.signal + '40',"]] });
add({ id: 'share.loading', fg: color.signal, on: 'sheetPaperRaised', kind: 'ui', at: [SH_SHEET, [SH, '<ActivityIndicator size="small" color={color.signal} />']] });
add({ id: 'share.empty.icon', fg: color.faint, on: 'sheetPaperRaised', kind: 'decor', at: [[SH, '<MessageCircle size={24} color={color.faint} />\n                      <Text style={s.emptyLabel}>No existing chats yet.</Text>']] }); // above its own label
add({ id: 'share.empty.label', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [SH_SHEET, [SH, "emptyLabel: { fontSize: 13, color: color.mute, textAlign: 'center' },"]] });
// A thread row, idle and selected, with its Avatar.
const SELECTED_ROW: Needle = [SH, "threadRowSelected: { backgroundColor: color.signal + '0A' },"];
add({ id: 'share.thread.name', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [SH_SHEET, [SH, "threadName: { fontSize: 14, fontWeight: '700', color: color.ink },"]] });
add({ id: 'share.thread.nameSelected', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal0A', kind: 'text', at: [SELECTED_ROW, [SH, 'threadNameSelected: { color: color.signalStrong },']] });
add({ id: 'share.thread.sub', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [SH_SHEET, [SH, 'threadSub: { fontSize: 11, color: color.mute, marginTop: 1 },']] });
add({ id: 'share.thread.subSelected', fg: color.mute, on: 'sheetPrSignal0A', kind: 'text', at: [SELECTED_ROW, [SH, 'threadSub: { fontSize: 11, color: color.mute, marginTop: 1 },']] });
const CHECK: Needle = [SH, "checkBadge: { width: icon.s20, height: icon.s20, borderRadius: icon.s20 / 2, backgroundColor: color.signalStrong, alignItems: 'center', justifyContent: 'center' },"];
add({ id: 'share.thread.check', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [CHECK, [SH, "checkText: { fontSize: 12, color: color.onInk, fontWeight: '700' },"]] }); // the ✓ glyph, measured as text
add({ id: 'share.thread.checkBadge', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal0A', kind: 'ui', at: [CHECK, SELECTED_ROW] });
const AV = SF.avatar;
const AV_FALLBACK: Needle = [AV, /fallback: \{\s*backgroundColor: color\.haze,/];
add({ id: 'share.avatar.initials', fg: color.ink, on: 'sheetHaze', kind: 'text', at: [[SH, 'kind={thread.threadType === \'trip\' ? \'trip\' : thread.threadType === \'circle\' ? \'circle\' : \'person\'}'], AV_FALLBACK, [AV, "initial: { ...t.small, fontWeight: '700', color: color.ink },"]] });
add({ id: 'share.avatar.glyph', fg: color.signal, on: 'sheetHaze', kind: 'decor', at: [AV_FALLBACK, [AV, 'const tint = selected ? color.onInk : color.signal;']] }); // the trip / circle glyph, beside the thread's name and its "Trip chat" / "Circle" line
const AV_SELECTED: Needle = [AV, 'fallbackSelected: { backgroundColor: color.signalStrong },'];
add({ id: 'share.avatar.initialsSelected', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [[SH, 'selected={selected}'], AV_SELECTED, [AV, 'selected && { color: color.onInk }']] });
add({ id: 'share.avatar.glyphSelected', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'decor', at: [AV_SELECTED, [AV, 'const tint = selected ? color.onInk : color.signal;']] });
add({ id: 'share.avatar.fillSelected', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal0A', kind: 'ui', at: [AV_SELECTED, SELECTED_ROW] });
add({ id: 'share.avatar.ringSelected', fg: color.ink, on: 'sheetPrSignal0A', kind: 'ui', at: [[AV, 'selectedRing: { borderWidth: 2, borderColor: color.ink },'], SELECTED_ROW] });
add({ id: 'share.people', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [[SH, /peopleDividerRow: \{[^}]*backgroundColor: color\.paper,/], [SH, /peopleDividerText: \{[^}]*color: color\.mute,/]] });
const START_CHAT: Needle = [SH, /startChatBadge: \{[^}]*backgroundColor: color\.signal \+ '15',/];
add({ id: 'share.startChat', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal15', kind: 'text', at: [START_CHAT, [SH, "startChatText: { fontSize: 12, fontWeight: '700', color: color.signalStrong },"]] });
// Send.
const SEND_BTN: Needle = [SH, /sendBtn: \{[^}]*backgroundColor: color\.signalStrong,/];
add({ id: 'share.send.label', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [SEND_BTN, [SH, "sendLabel: { fontSize: 15, fontWeight: '700', color: color.onInk },"]] });
add({ id: 'share.send.icon', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'decor', at: [SEND_BTN, [SH, '<Send size={15} color={color.onInk} />']] }); // beside "Send"
add({ id: 'share.send.spinner', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'ui', at: [SEND_BTN, [SH, '{sending ? (\n                <ActivityIndicator size="small" color={color.onInk} />']] });
add({ id: 'share.send.disabled', fg: atOpacity(color.onInk, 0.45, color.paperRaised), on: 'sheetShareSendDisabled', wasOn: 'sheetShareSendDisabledWas', kind: 'decor', at: [SEND_BTN, [SH, 'sendBtnDisabled: { opacity: 0.45 },']] }); // disabled until a chat is chosen (1.4.3)

// ═══ GlobalPlacePicker — the add-gem sheet's place field ══════════════════════
const PP = SF.placePicker;
const PP_SHEET: Needle = [PP, /sheet: \{\s*backgroundColor: color\.paper,/];
const PP_OPENED: Needle = ['src/components/media/AddGemForm.tsx', '<GlobalPlacePicker'];
add({ id: 'placePicker.title', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [PP_OPENED, PP_SHEET, [PP, 'title: { ...t.heading, color: color.ink, flex: 1 },']] });
add({ id: 'placePicker.close', fg: color.mute, on: 'sheetPaper', kind: 'ui', at: [PP_SHEET, [PP, '<X size={18} color={color.mute} />']] });
const PP_SEARCH: Needle = [PP, /searchRow: \{[^}]*backgroundColor: color\.paperRaised,/];
add({ id: 'placePicker.search.text', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [PP_SEARCH, [PP, 'input: { flex: 1, ...t.body, color: color.ink },']] });
add({ id: 'placePicker.search.placeholder', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', at: [PP_SEARCH, [PP, "placeholder={placeholder ?? (cityMode ? 'Search cities…' : 'Search cities, hotels, landmarks…')}\n              placeholderTextColor={color.mute}"]] });
add({ id: 'placePicker.search.icon', fg: color.mute, on: 'sheetPaperRaised', kind: 'decor', at: [PP_SEARCH, [PP, '<Search size={16} color={color.mute} />']] }); // beside the placeholder
add({ id: 'placePicker.search.loading', fg: color.signal, on: 'sheetPaperRaised', kind: 'ui', at: [PP_SEARCH, [PP, '{(searching || googleLoading) && <ActivityIndicator size="small" color={color.signal} />}']] });
add({ id: 'placePicker.search.clear', fg: color.mute, on: 'sheetPaperRaised', kind: 'ui', at: [PP_SEARCH, [PP, '<X size={14} color={color.mute} />']] });
add({ id: 'placePicker.search.outline', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [PP_SEARCH] });
add({ id: 'placePicker.gpsMessage', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PP_SHEET, [PP, 'gpsMsg: { ...t.small, color: color.mute, paddingHorizontal: space.xl, paddingBottom: space.sm },']] });
add({ id: 'placePicker.section', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PP_SHEET, [PP, "...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, fontWeight: '700',"]] });
add({ id: 'placePicker.sectionIcon', fg: color.mute, on: 'sheetPaper', kind: 'decor', at: [[PP, '<TrendingUp size={11} color={color.mute} />']] }); // beside "Popular on Portava"
add({ id: 'placePicker.attribution', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PP_SHEET, [PP, /googleAttribText: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
const PP_ERROR: Needle = [PP, /errorRow: \{[^}]*backgroundColor: color\.paperRaised,/];
add({ id: 'placePicker.error.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [PP_ERROR, [PP, "errorTitle: { ...t.body, color: color.ink, fontWeight: '600' },"]] });
add({ id: 'placePicker.error.sub', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [PP_ERROR, [PP, 'rowSub: { ...t.small, color: color.mute, marginTop: 1 },']] });
add({ id: 'placePicker.error.retry', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', at: [PP_ERROR, [PP, "retryText: { ...t.small, color: color.signalStrong, fontWeight: '700' },"]] });
add({ id: 'placePicker.error.retryIcon', fg: color.signal, on: 'sheetPaperRaised', kind: 'decor', at: [PP_ERROR, [PP, '<RefreshCw size={13} color={color.signal} />']] }); // beside "Retry"
add({ id: 'placePicker.error.retryOutline', fg: color.signal, on: 'sheetPaperRaised', kind: 'decor', at: [PP_ERROR, [PP, 'borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal,']] }); // "Retry" names the button
// The rows, on the paper sheet.
add({ id: 'placePicker.gps.name', fg: color.signalStrong, was: color.signal, on: 'sheetPaper', kind: 'text', at: [PP_SHEET, [PP, "<Text style={[s.rowName, { color: color.signalStrong }]}>Use my current location</Text>"]] });
add({ id: 'placePicker.row.sub', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PP_SHEET, [PP, 'rowSub: { ...t.small, color: color.mute, marginTop: 1 },']] });
add({ id: 'placePicker.gps.icon', fg: color.signal, on: 'sheetPSignal20', kind: 'decor', at: [[PP, '<View style={[s.iconCircle, { backgroundColor: `${color.signal}20` }]}>'], [PP, ': <Navigation size={16} color={color.signal} />}']] }); // beside "Use my current location"
add({ id: 'placePicker.gps.loading', fg: color.signalStrong, was: color.signal, on: 'sheetPSignal20', kind: 'ui', at: [[PP, '<View style={[s.iconCircle, { backgroundColor: `${color.signal}20` }]}>\n                      {gpsState === \'loading\'\n                        ? <ActivityIndicator size="small" color={color.signalStrong} />']] });
add({ id: 'placePicker.row.name', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [PP_SHEET, [PP, "rowName: { ...t.body, color: color.ink, fontWeight: '600' },"]] });
add({ id: 'placePicker.custom.icon', fg: color.signal, on: 'sheetPSignal15', kind: 'decor', at: [[PP, '<View style={[s.iconCircle, { backgroundColor: `${color.signal}15` }]}>'], [PP, ': <MapPin size={16} color={color.signal} />}']] }); // beside "Use «query»"
add({ id: 'placePicker.custom.loading', fg: color.signalStrong, was: color.signal, on: 'sheetPSignal15', kind: 'ui', at: [[PP, '<View style={[s.iconCircle, { backgroundColor: `${color.signal}15` }]}>\n                      {resolvingId != null\n                        ? <ActivityIndicator size="small" color={color.signalStrong} />']] });
add({ id: 'placePicker.row.icon', fg: color.mute, on: 'sheetPaperRaised', kind: 'decor', at: [[PP, /iconCircle: \{[^}]*backgroundColor: color\.paperRaised,/], [PP, "{icon === 'pin' && <MapPin size={15} color={color.mute} />}"]] }); // beside the place's name
add({ id: 'placePicker.row.nearIcon', fg: color.signal, on: 'sheetPSignal15', kind: 'decor', at: [[PP, "{icon === 'near' && <Navigation size={15} color={color.signal} />}"]] }); // beside the place's name, under "Near You"
add({ id: 'placePicker.row.resolving', fg: color.signal, on: 'sheetPaper', kind: 'ui', at: [PP_SHEET, [PP, '{resolving && <ActivityIndicator size="small" color={color.signal} />}']] });
add({ id: 'placePicker.empty', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PP_SHEET, [PP, "emptyText: { ...t.body, color: color.mute, textAlign: 'center' },"]] });

// ═══ PlanPickerController — "Add to Trip Plan" ════════════════════════════════
const PL = SF.planPicker;
const PL_SHEET: Needle = [PL, /sheet: \{[^}]*backgroundColor: color\.paper,/];
const PL_OPENED: Needle = ['src/features/media/components/MediaActionRail.tsx', 'usePlanPicker'];
add({ id: 'planPicker.title', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [PL_OPENED, PL_SHEET, [PL, 'title: { ...t.title, color: color.ink, fontSize: 19 },']] });
add({ id: 'planPicker.back', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [[PL, '<ChevronLeft size={18} color={color.ink} />'], [PL, /backBtn: \{[^}]*backgroundColor: color\.paperRaised,/]] });
add({ id: 'planPicker.close', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [[PL, '<X size={18} color={color.ink} />'], [PL, /xBtn: \{[^}]*backgroundColor: color\.paperRaised,/]] });
const PL_PREVIEW: Needle = [PL, /preview: \{[^}]*backgroundColor: color\.paperRaised,/];
add({ id: 'planPicker.preview.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [PL_PREVIEW, [PL, 'previewTitle: { ...t.bodyStrong, color: color.ink },']] });
add({ id: 'planPicker.preview.meta', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [PL_PREVIEW, [PL, 'previewMeta: { ...t.small, color: color.mute, fontSize: 11 },']] });
add({ id: 'planPicker.preview.icon', fg: color.onInk, on: 'sheetDeep', kind: 'decor', at: [[PL, '<View style={s.previewIcon}><MapPin size={16} color={color.onInk} /></View>']] }); // beside the item's title
add({ id: 'planPicker.error', fg: color.signalStrong, was: color.signal, on: 'sheetPaper', kind: 'text', at: [PL_SHEET, [PL, "error: { ...t.small, color: color.signalStrong, fontWeight: '600' },"]] });
add({ id: 'planPicker.empty', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PL_SHEET, [PL, "emptyText: { ...t.body, color: color.mute, textAlign: 'center' },"]] });
add({ id: 'planPicker.loading', fg: color.signal, on: 'sheetPaper', kind: 'ui', at: [PL_SHEET, [PL, '<ActivityIndicator color={color.signal} style={{ marginVertical: space.xl }} />']] });
add({ id: 'planPicker.pickLabel', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PL_SHEET, [PL, "pickerLabel: { ...t.small, fontWeight: '700', color: color.mute,"]] });
const PL_TRIP: Needle = [PL, /tripRow: \{[^}]*backgroundColor: color\.paperRaised,/];
add({ id: 'planPicker.trip.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [PL_TRIP, [PL, 'tripTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },']] });
add({ id: 'planPicker.trip.meta', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [PL_TRIP, [PL, 'tripMeta: { ...t.small, color: color.mute, fontSize: 11 },']] });
add({ id: 'planPicker.trip.icon', fg: color.deep, on: 'sheetTealTint', kind: 'decor', at: [[PL, '<View style={s.tripIcon}><MapPin size={14} color={color.deep} /></View>'], [PL, "backgroundColor: '#E2EDF0'"]] }); // beside the trip's title
add({ id: 'planPicker.create.label', fg: color.signalStrong, was: color.signal, on: 'sheetPaper', kind: 'text', at: [PL_SHEET, [PL, 'createText: { ...t.bodyStrong, color: color.signalStrong, fontSize: 14 },']] });
add({ id: 'planPicker.create.icon', fg: color.onInk, on: 'sheetSignal', kind: 'decor', at: [[PL, '<Plus size={14} color={color.onInk} />'], [PL, /createIcon: \{[^}]*backgroundColor: color\.signal,/]] }); // beside "Create new trip"
add({ id: 'planPicker.create.outline', fg: hexA(color.signal, '50'), on: 'sheetPaper', kind: 'decor', at: [[PL, "borderColor: color.signal + '50', borderStyle: 'dashed',"]] });
const PL_CHIP: Needle = [PL, "backgroundColor: color.signal + '12', borderRadius: radius.pill,"];
add({ id: 'planPicker.selectedTrip', fg: color.signalStrong, was: color.signal, on: 'sheetPSignal12', kind: 'text', at: [PL_CHIP, [PL, "selectedTripText: { ...t.small, color: color.signalStrong, fontWeight: '700', fontSize: 12 },"]] });
add({ id: 'planPicker.selectedTripIcon', fg: color.signal, on: 'sheetPSignal12', kind: 'decor', at: [PL_CHIP, [PL, '<MapPin size={12} color={color.signal} />']] }); // beside the trip's title
add({ id: 'planPicker.fieldLabel', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [PL_SHEET, [PL, "fieldLabel: { ...t.small, fontWeight: '700', color: color.ink, marginTop: 2 },"]] });
add({ id: 'planPicker.fieldOptional', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PL_SHEET, [PL, "fieldOpt: { fontWeight: '400', color: color.mute },"]] });
// DatePickerField — its own paper field.
const DF = SF.dateField;
const DF_FIELD: Needle = [DF, /field: \{[^}]*backgroundColor: color\.paper,/];
const DF_USED: Needle = [PL, '<DatePickerField']; // resolved to DateTimePickerField.tsx by the consumer scan in sharedSheetContrast.consumers.test.ts
add({ id: 'planPicker.date.value', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [DF_USED, DF_FIELD, [DF, /fieldText: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]] });
add({ id: 'planPicker.date.placeholder', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [DF_USED, DF_FIELD, [DF, /placeholder: \{\s*color: color\.mute,/], [DF, '<Text style={[s.fieldText, !value && s.placeholder]}>']] });
add({ id: 'planPicker.date.icon', fg: color.faint, on: 'sheetPaper', kind: 'decor', at: [DF_FIELD, [DF, '<CalendarClock size={14} color={value ? color.signal : color.faint} />']] }); // beside the placeholder or the value
add({ id: 'planPicker.date.iconSet', fg: color.signal, on: 'sheetPaper', kind: 'decor', at: [DF_FIELD, [DF, '<CalendarClock size={14} color={value ? color.signal : color.faint} />']] });
add({ id: 'planPicker.date.clear', fg: color.mute, on: 'sheetPaper', kind: 'ui', at: [[DF, '<X size={15} color={color.mute} />']] });
add({ id: 'planPicker.date.openOutline', fg: color.signal, on: 'sheetPaper', kind: 'ui', at: [[DF, /fieldOpen: \{\s*borderColor: color\.signal,/]] }); // the open state
add({ id: 'planPicker.date.outline', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [DF_FIELD, [DF, /field: \{[^}]*borderColor: color\.haze,/]] }); // its placeholder names it
add({ id: 'planPicker.date.done', fg: color.signalStrong, was: color.signal, on: 'sheetPaper', kind: 'text', at: [[DF, /doneBtn: \{[^}]*backgroundColor: color\.paper,/], [DF, /doneBtnText: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.signalStrong,/]] }); // iOS, while the spinner is open
// LockTypeSelector — its own chips.
const LT = SF.lockType;
const LT_USED: Needle = [PL, '<LockTypeSelector value={lockType} onChange={setLockType} />'];
add({ id: 'planPicker.lock.chip', fg: color.muteStrong, was: color.mute, on: 'sheetHaze', kind: 'text', at: [LT_USED, [LT, "chip:           { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.haze },"], [LT, "chipText:       { ...t.small, color: color.muteStrong, fontWeight: '600' },"]] });
add({ id: 'planPicker.lock.chipActive', fg: '#FFFFFF', on: 'sheetDeep', kind: 'text', at: [LT_USED, [LT, 'chipActive:     { backgroundColor: color.deep },'], [LT, "chipTextActive: { color: '#fff' },"]] });
add({ id: 'planPicker.lock.selectedFill', fg: color.deep, on: 'sheetPaper', kind: 'ui', at: [LT_USED, PL_SHEET, [LT, 'chipActive:     { backgroundColor: color.deep },']] });
add({ id: 'planPicker.lock.chipFill', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [LT_USED, [LT, "chip:           { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.haze },"]] }); // each chip's label names it
add({ id: 'planPicker.lock.hint', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [LT_USED, PL_SHEET, [LT, 'hint:           { ...t.small, color: color.mute },']] });
// Confirm, and the toast.
const CONFIRM: Needle = [PL, "confirmBtn: { marginTop: space.sm, backgroundColor: color.signalStrong, borderRadius: radius.md,"];
add({ id: 'planPicker.confirm.label', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [CONFIRM, [PL, 'confirmBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 15 },']] });
add({ id: 'planPicker.confirm.spinner', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'ui', at: [CONFIRM, [PL, '? <ActivityIndicator size="small" color={color.onInk} />\n                  : <Text style={s.confirmBtnText}>Add to Plan</Text>']] });
add({ id: 'planPicker.confirm.submitting', fg: atOpacity(color.onInk, 0.6, color.paper), on: 'sheetPlanConfirmSubmitting', wasOn: 'sheetPlanConfirmSubmittingWas', kind: 'decor', at: [CONFIRM, [PL, 'confirmBtnDisabled: { opacity: 0.6 },']] }); // the spinner carries the state while it is disabled
add({ id: 'planPicker.toast', fg: color.onInk, on: 'sheetInk', kind: 'text', at: [[PL, /toast: \{[^}]*backgroundColor: color\.ink,/], [PL, 'toastText: { ...t.bodyStrong, color: color.onInk },']] });
add({ id: 'planPicker.toastIcon', fg: color.onInk, on: 'sheetInk', kind: 'decor', at: [[PL, '<Check size={16} color={color.onInk} />']] }); // beside the toast's text

// ═══ DisambiguationSheet — CreationAssist's "See all" in the add-gem sheet ═════
const DS = SF.disambiguation;
const ER = SF.entityRow;
const DS_SHEET: Needle = [DS, /sheet: \{[^}]*backgroundColor: color\.paperRaised,/];
const DS_OPENED: Needle = ['src/platform/input-assistance/creation/CreationAssist.tsx', '<DisambiguationSheet'];
add({ id: 'disambiguation.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [DS_OPENED, DS_SHEET, [DS, /title: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'disambiguation.row.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [DS_SHEET, [ER, /title: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.ink,/]] });
add({ id: 'disambiguation.row.subtitle', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [DS_SHEET, [ER, /subtitle: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'disambiguation.row.reason', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', at: [DS_SHEET, [DS, '<EntitySuggestionRow key={c.id} suggestion={c} onPress={onSelect} reasonColor={color.mute} />'], [ER, 'reasonColor === undefined ? styles.reason : [styles.reason, { color: reasonColor }]']] });
add({ id: 'disambiguation.row.badge', fg: color.deep, on: 'sheetPaper', kind: 'text', at: [[ER, /badge: \{[^}]*backgroundColor: color\.paper,/], [ER, /badgeText: \{\s*\.\.\.t\.stamp,\s*color: color\.deep,/]] });
add({ id: 'disambiguation.row.fresh', fg: color.deep, on: 'sheetPaper', kind: 'text', at: [[ER, /freshBadge: \{[^}]*backgroundColor: color\.paper,/], [ER, /freshText: \{\s*\.\.\.t\.stamp,\s*color: color\.deep,/]] });
add({ id: 'disambiguation.row.icon', fg: color.deep, on: 'sheetPaper', kind: 'decor', at: [[ER, '<EntityIcon entityType={suggestion.entityType} tint={color.deep} />']] }); // beside the row's title
add({ id: 'disambiguation.searchInstead', fg: color.deep, on: 'sheetPaperRaised', kind: 'text', at: [DS_SHEET, [DS, /searchInsteadText: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.deep,/]] });
add({ id: 'disambiguation.searchInsteadIcon', fg: color.deep, on: 'sheetPaperRaised', kind: 'decor', at: [[DS, '<Search size={iconToken.s18} color={color.deep} />']] }); // beside "Search «query» instead"

/** Every pair of the five sheets as they render when opened from Media. */
export const MEDIA_SHEET_PAIRS: readonly SheetPair[] = P;
