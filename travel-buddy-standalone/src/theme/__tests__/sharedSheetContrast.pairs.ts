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
export type SheetSurface = keyof typeof SHEET_SURFACES | keyof typeof NESTED_SURFACES; // §33.13: plus the nested sheets' grounds, declared at the tail

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

// ═══ census-media §33.13 — the nested sheets, appended at the TAIL so the lines §33 cites do not move ═══
//
// The owner's H7 ruling reaches every surface a user meets in the Media flow. From the five sheets
// above, these open ON TOP of the flow without leaving it (a navigation to another screen leaves it):
//   - TagPreviewSheet: long-press an @mention or #hashtag in a comment (RichText);
//   - ProfilePreviewCard: tap a comment's author;
//   - EngagementUserListSheet: tap a comment's like count;
//   - ReportSheet: long-press a comment, then Report — its three steps, and for a safety concern the
//     photo button (MediaPickerButton), the source sheet it opens (MediaSourceSheet) and the picked
//     photo's card (MediaAttachmentTray, one image: no cover, reorder or alt text for this policy).
// OS-drawn UI (Alert dialogs, the camera and photo library, Settings, the browser) is not paired.
// The add(...) calls below push into the same array MEDIA_SHEET_PAIRS exports, so both suites read them.

/** Files of the nested sheets and what they draw, relative to the standalone app root. */
export const SF_NESTED = {
  tagPreview: 'src/components/TagPreviewSheet.tsx',
  profilePreview: 'src/components/ProfilePreviewCard.tsx',
  avatarImage: 'src/components/ui/DisplayMediaImage.tsx',
  likers: 'src/components/EngagementUserListSheet.tsx',
  report: 'src/components/ReportSheet.tsx',
  photoButton: 'src/components/ui/MediaPickerButton.tsx',
  sourceSheet: 'src/components/ui/MediaSourceSheet.tsx',
  tray: 'src/components/ui/MediaAttachmentTray.tsx',
} as const;

/** The literal a bottom layer uses for "any photograph": floored over a 16-level grid, as in mediaContrast.test.ts. */
const PHOTO_LAYER = 'PHOTO';

export const NESTED_SURFACES = {
  sheetPrSignal18: [color.paperRaised, hexA(color.signal, '18')],
  sheetPrDeep15: [color.paperRaised, hexA(color.deep, '15')],
  sheetPrDeep18: [color.paperRaised, hexA(color.deep, '18')],
  sheetPrWarn18: [color.paperRaised, hexA(color.warn, '18')],
  sheetPrViolet18: [color.paperRaised, hexA('#8B5CF6', '18')],
  sheetPrSuccess18: [color.paperRaised, hexA(color.success, '18')],
  sheetSafety: ['#FEF3C7'],
  /** ReportSheet's primary button while disabled (`opacity: 0.45` on the sheet), now and before §33. */
  sheetReportDisabled: [atOpacity(color.signalStrong, 0.45, color.paperRaised)],
  sheetReportDisabledWas: [atOpacity(color.signal, 0.45, color.paperRaised)],
  /** MediaSourceSheet's "Settings" chip in a denied row, before §33 drew the row at opacity 0.7. */
  sheetDeniedSettingsWas: [atOpacity(color.haze, 0.7, color.paperRaised)],
  /** MediaAttachmentTray, over the picked photo. */
  trayScrimPhoto: [PHOTO_LAYER, 'rgba(0,0,0,0.55)'],
  trayTrackPhoto: [PHOTO_LAYER, 'rgba(0,0,0,0.55)', 'rgba(17,17,15,0.4)'],
  trayTrackPhotoWas: [PHOTO_LAYER, 'rgba(0,0,0,0.55)', 'rgba(255,255,255,0.35)'],
  trayCancelPhoto: [PHOTO_LAYER, 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.45)'],
  trayRetryPhoto: [PHOTO_LAYER, 'rgba(255,77,46,0.6)', 'rgba(0,0,0,0.45)'],
  trayRemoveOnErrorPhoto: [PHOTO_LAYER, 'rgba(255,77,46,0.6)', 'rgba(0,0,0,0.55)'],
} as const satisfies Record<string, readonly string[]>;

/** Every ground either list names. */
export const ALL_SHEET_SURFACES: Record<SheetSurface, readonly string[]> = { ...SHEET_SURFACES, ...NESTED_SURFACES };

const AVATAR_FALLBACK: Needle[] = [[SF.avatar, /fallback: \{\s*backgroundColor: color\.haze,/], [SF.avatar, "initial: { ...t.small, fontWeight: '700', color: color.ink },"]];

// ─ TagPreviewSheet — long-press an @mention or #hashtag in a comment ─
const TP = SF_NESTED.tagPreview;
const TP_SHEET: Needle = [TP, /sheet: \{\s*backgroundColor: color\.paperRaised,/];
const TP_OPENED: Needle[] = [[SF.richText, "onLongPress={() => setPreview({ kind: 'hashtag', hashtag: seg.hashtag })}"], [SF.richText, '<TagPreviewSheet']];
add({ id: 'tagPreview.header', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [...TP_OPENED, TP_SHEET, [TP, "headerLabel: { ...t.small, color: color.mute, fontWeight: '600' },"]] });
add({ id: 'tagPreview.close', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [TP_SHEET, [TP, '<X size={18} color={color.ink} />']] });
add({ id: 'tagPreview.loading', fg: color.signal, on: 'sheetPaperRaised', kind: 'ui', at: [TP_SHEET, [TP, '<ActivityIndicator color={color.signal} />']] });
add({ id: 'tagPreview.error', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, [TP, "errorText: { ...t.small, color: color.mute, textAlign: 'center' },"]] });
add({ id: 'tagPreview.hashtag.icon', fg: color.deep, on: 'sheetPrDeep15', kind: 'decor', at: [[TP, "backgroundColor: color.deep + '15'"], [TP, '<Hash size={28} color={color.deep} />']] }); // beside "#slug" and under the "Hashtag" header
add({ id: 'tagPreview.hashtag.slug', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, [TP, "hashtagSlug: { ...t.title, color: color.ink, textAlign: 'center' },"]] });
add({ id: 'tagPreview.sub', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, [TP, 'entitySub: { ...t.small, color: color.mute },']] });
const TP_FOLLOW: Needle = [TP, /followBtn: \{[^}]*backgroundColor: color\.deep,/];
const TP_FOLLOWING: Needle = [TP, "backgroundColor: color.deep + '18', borderWidth: 1.5, borderColor: color.deep,"];
add({ id: 'tagPreview.follow.label', fg: color.onInk, on: 'sheetDeep', kind: 'text', at: [TP_FOLLOW, [TP, "followBtnText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },"]] });
add({ id: 'tagPreview.follow.following', fg: color.deep, on: 'sheetPrDeep18', kind: 'text', at: [TP_FOLLOWING, [TP, 'followBtnTextActive: { color: color.deep },']] });
add({ id: 'tagPreview.follow.spinner', fg: color.onInk, on: 'sheetDeep', kind: 'ui', at: [TP_FOLLOW, [TP, '<ActivityIndicator size="small" color={following ? color.deep : color.onInk} />']] });
add({ id: 'tagPreview.follow.spinnerFollowing', fg: color.deep, on: 'sheetPrDeep18', kind: 'ui', at: [TP_FOLLOWING, [TP, '<ActivityIndicator size="small" color={following ? color.deep : color.onInk} />']] });
add({ id: 'tagPreview.viewFeed', fg: color.ink, on: 'sheetHaze', kind: 'text', at: [[TP, /viewBtn: \{[^}]*backgroundColor: color\.haze,/], [TP, "viewBtnText: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },"]] });
const TP_REPORT: Needle = [TP, 'paddingVertical: space.xs, opacity: 1,'];
add({ id: 'tagPreview.report.label', fg: color.mute, was: atOpacity(color.faint, 0.6, color.paperRaised), on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, TP_REPORT, [TP, 'reportBtnText: { ...t.small, color: color.mute },']] });
add({ id: 'tagPreview.report.icon', fg: color.mute, was: atOpacity(color.faint, 0.6, color.paperRaised), on: 'sheetPaperRaised', kind: 'decor', at: [TP_REPORT, [TP, '<Flag size={12} color={color.mute} />']] }); // beside "Report hashtag"
add({ id: 'tagPreview.report.spinner', fg: color.mute, was: atOpacity(color.faint, 0.6, color.paperRaised), on: 'sheetPaperRaised', kind: 'ui', at: [TP_REPORT, [TP, '? <ActivityIndicator size="small" color={color.mute} />']] });
add({ id: 'tagPreview.user.name', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, [TP, "userName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },"]] });
add({ id: 'tagPreview.user.handle', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, [TP, 'userHandle: { ...t.small, color: color.mute },']] });
add({ id: 'tagPreview.user.bio', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, [TP, 'userBio: { ...t.body, color: color.mute,']] });
add({ id: 'tagPreview.user.avatarInitials', fg: color.ink, on: 'sheetHaze', kind: 'text', at: [[TP, '<Avatar uri={data.avatarUrl} name={data.name ?? data.handle} size={56} />'], ...AVATAR_FALLBACK] });
add({ id: 'tagPreview.cta', fg: color.onInk, on: 'sheetInk', kind: 'text', at: [[TP, /viewBtnFull: \{[^}]*backgroundColor: color\.ink,/], [TP, "viewBtnFullText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },"]] });
add({ id: 'tagPreview.minimal.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [TP_SHEET, [TP, "entityTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center', fontWeight: '700' },"]] });
add({ id: 'tagPreview.minimal.close', fg: color.muteStrong, was: color.mute, on: 'sheetHaze', kind: 'text', at: [[TP, /dimBtnFull: \{[^}]*backgroundColor: color\.haze,/], [TP, "dimBtnText: { ...t.bodyStrong, color: color.muteStrong, fontWeight: '600' },"]] });
for (const [kind, fg, on, needle] of [
  ['trip', color.deep, 'sheetPrDeep18', "iconBg={color.deep + '18'}"],
  ['circle', color.warn, 'sheetPrWarn18', "iconBg={color.warn + '18'}"],
  ['event', '#8B5CF6', 'sheetPrViolet18', "iconBg={'#8B5CF6' + '18'}"],
  ['place', color.success, 'sheetPrSuccess18', "iconBg={color.success + '18'}"],
] as const) {
  add({ id: `tagPreview.minimal.${kind}Icon`, fg, on, kind: 'decor', at: [[TP, needle], [TP, '<Icon size={28} color={iconColor} />']] }); // beside the entity's title and its type line
}

// ─ ProfilePreviewCard — tap a comment's author ─
const PV = SF_NESTED.profilePreview;
const PV_SHEET: Needle = [PV, /sheet: \{\s*backgroundColor: color\.paper,/];
add({ id: 'profilePreview.close', fg: color.mute, on: 'sheetPaper', kind: 'ui', at: [[SF.comments, '<ProfilePreviewCard'], PV_SHEET, [PV, '<X size={20} color={color.mute} />']] });
add({ id: 'profilePreview.loading', fg: color.mute, on: 'sheetPaper', kind: 'ui', at: [PV_SHEET, [PV, '<ActivityIndicator size="large" color={color.mute} />']] });
add({ id: 'profilePreview.empty', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PV_SHEET, [PV, 'emptyText: { ...t.body, color: color.mute },']] });
add({ id: 'profilePreview.avatarInitials', fg: '#FFFFFF', on: 'sheetDeep', wasOn: 'sheetHaze', kind: 'text', at: [[PV, 'style={s.avatar}'], [PV, "backgroundColor: color.deep, // AvatarImage's own ground"], [SF_NESTED.avatarImage, "initials: { color: '#fff', fontWeight: '700' },"]] });
add({ id: 'profilePreview.name', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [PV_SHEET, [PV, "name: { ...t.bodyStrong, color: color.ink, fontWeight: '700', marginTop: space.xs, fontSize: 17 },"]] });
add({ id: 'profilePreview.handle', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PV_SHEET, [PV, 'handleText: { ...t.small, color: color.mute },']] });
add({ id: 'profilePreview.bio', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [PV_SHEET, [PV, /bio: \{\s*\.\.\.t\.body,\s*color: color\.ink,/]] });
add({ id: 'profilePreview.statNum', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [PV_SHEET, [PV, "statNum: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },"]] });
add({ id: 'profilePreview.statLabel', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [PV_SHEET, [PV, 'statLabel: { ...t.small, color: color.mute, fontSize: 11 },']] });
add({ id: 'profilePreview.view', fg: color.onInk, on: 'sheetInk', kind: 'text', at: [[PV, /viewBtn: \{\s*backgroundColor: color\.ink,/], [PV, "viewBtnText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },"]] });

// ─ EngagementUserListSheet — tap a comment's like count ─
const EU = SF_NESTED.likers;
const EU_SHEET: Needle = [EU, /sheet: \{\s*backgroundColor: color\.paper,/];
add({ id: 'likers.title', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [[SF.comments, '<EngagementUserListSheet'], EU_SHEET, [EU, /title: \{\s*flex: 1,\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'likers.close', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [[EU, '<X size={18} color={color.ink} />'], [EU, /closeBtn: \{[^}]*backgroundColor: color\.paperRaised,/]] });
add({ id: 'likers.loading', fg: color.signal, on: 'sheetPaper', kind: 'ui', at: [EU_SHEET, [EU, '<ActivityIndicator size="small" color={color.signal} />']] });
add({ id: 'likers.loadingMore', fg: color.signal, on: 'sheetPaper', kind: 'ui', at: [EU_SHEET, [EU, /color=\{color\.signal\}\n\s*style=\{\{ paddingVertical: 12 \}\}/]] });
add({ id: 'likers.empty', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [EU_SHEET, [EU, /emptyText: \{\s*\.\.\.t\.body,\s*color: color\.mute,/]] });
add({ id: 'likers.retry', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [[EU, /retryBtn: \{[^}]*backgroundColor: color\.signalStrong,/], [EU, /retryText: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInk,/]] });
add({ id: 'likers.row.name', fg: color.ink, on: 'sheetPaper', kind: 'text', at: [EU_SHEET, [EU, /name: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.ink,/]] });
add({ id: 'likers.row.verified', fg: '#1A3A5C', on: 'sheetPaper', kind: 'ui', at: [[EU, '{user.verified ? <VerifiedStamp size="sm" /> : null}'], [SF.verified, "const ink = dark ? 'rgba(250,249,246,0.92)' : '#1A3A5C';"]] });
add({ id: 'likers.row.handle', fg: color.mute, was: color.faint, on: 'sheetPaper', kind: 'text', at: [EU_SHEET, [EU, /handle: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'likers.row.avatarInitials', fg: color.ink, on: 'sheetHaze', kind: 'text', at: [[EU, '<Avatar'], ...AVATAR_FALLBACK] });
add({ id: 'likers.row.followsYou', fg: color.muteStrong, was: color.mute, on: 'sheetHaze', kind: 'text', at: [[EU, /followsYouBadge: \{\s*backgroundColor: color\.haze,/], [EU, /followsYouText: \{[^}]*color: color\.muteStrong,/]] });
const EU_FOLLOW: Needle = [EU, /followBtn: \{[^}]*backgroundColor: color\.signalStrong,/];
add({ id: 'likers.row.follow', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [EU_FOLLOW, [EU, /followText: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.onInk,/]] });
add({ id: 'likers.row.followSpinner', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'ui', at: [EU_FOLLOW, [EU, 'color={isFollowing ? color.mute : color.onInk}']] });
add({ id: 'likers.row.following', fg: color.mute, on: 'sheetPaper', kind: 'text', at: [EU_SHEET, [EU, /followingText: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.mute,/]] });
add({ id: 'likers.row.followingSpinner', fg: color.mute, on: 'sheetPaper', kind: 'ui', at: [EU_SHEET, [EU, 'color={isFollowing ? color.mute : color.onInk}']] });
add({ id: 'likers.row.followingOutline', fg: color.haze, on: 'sheetPaper', kind: 'decor', at: [[EU, /followingBtn: \{[^}]*borderColor: color\.haze,/]] }); // "Following" names the button

// ─ ReportSheet — long-press a comment, then Report ─
const RS = SF_NESTED.report;
const RS_SHEET: Needle = [RS, /sheet: \{\s*backgroundColor: color\.paperRaised,/];
const RS_SELECTED: Needle = [RS, "optionRowSelected: { borderColor: color.signal, backgroundColor: color.signal + '0A' },"];
const RS_PRIMARY: Needle = [RS, /primaryBtn: \{[^}]*backgroundColor: color\.signalStrong,/];
add({ id: 'report.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [[SF.comments, '<ReportSheet'], RS_SHEET, [RS, "title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16 },"]] });
add({ id: 'report.sub', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, 'sub:   { ...t.small, color: color.mute, marginBottom: space.md },']] });
add({ id: 'report.close', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [RS_SHEET, [RS, '<X size={20} color={color.ink} />']] });
add({ id: 'report.option.label', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, 'optionLabel:         { ...t.body, color: color.ink },']] });
add({ id: 'report.option.outline', fg: color.haze, on: 'sheetPaperRaised', kind: 'decor', at: [[RS, /optionRow: \{[^}]*borderColor: color\.haze,/]] }); // each option's label names it
add({ id: 'report.option.selectedLabel', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal0A', kind: 'text', at: [RS_SELECTED, [RS, "optionLabelSelected: { color: color.signalStrong, fontWeight: '700' },"]] });
add({ id: 'report.option.check', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal0A', kind: 'text', at: [RS_SELECTED, [RS, "check: { fontSize: 14, color: color.signalStrong, fontWeight: '700' },"]] }); // the ✓ glyph, measured as text
add({ id: 'report.option.selectedOutline', fg: color.signal, on: 'sheetPaperRaised', kind: 'ui', at: [RS_SELECTED] }); // the selected state's second channel; the brand value clears 3:1
add({ id: 'report.primary.label', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'text', at: [RS_PRIMARY, [RS, "primaryBtnLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },"]] });
add({ id: 'report.primary.spinner', fg: color.onInk, on: 'sheetSignalStrong', wasOn: 'sheetSignal', kind: 'ui', at: [RS_PRIMARY, [RS, '? <ActivityIndicator size="small" color={color.onInk} />\n                  : <Text style={rs.primaryBtnLabel}>Submit report</Text>}']] });
add({ id: 'report.primary.disabled', fg: atOpacity(color.onInk, 0.45, color.paperRaised), on: 'sheetReportDisabled', wasOn: 'sheetReportDisabledWas', kind: 'decor', at: [RS_PRIMARY, [RS, 'btnDisabled:    { opacity: 0.45 },']] }); // "Next" before a category is chosen (1.4.3)
add({ id: 'report.back', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, 'backLabel: { ...t.body, color: color.signalStrong },']] });
const RS_DETAILS: Needle = [RS, /detailInput: \{[^}]*color: color\.ink,/];
add({ id: 'report.details.text', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, RS_DETAILS] });
add({ id: 'report.details.placeholder', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, 'placeholder="Describe what happened…"\n                placeholderTextColor={color.mute}']] });
add({ id: 'report.details.outline', fg: color.haze, on: 'sheetPaperRaised', kind: 'decor', at: [[RS, /detailInput: \{\s*borderWidth: 1,\s*borderColor: color\.haze,/]] }); // its placeholder names it
add({ id: 'report.details.count', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, "charCount: { ...t.small, color: color.mute, textAlign: 'right', marginBottom: space.sm },"]] });
add({ id: 'report.photoLabel', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, "photoLabel: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 2 },"]] });
add({ id: 'report.done.icon', fg: '#000000', on: 'sheetPaperRaised', kind: 'decor', at: [[RS, 'doneIcon: { fontSize: 38, marginBottom: space.sm },']] }); // the ✓ in the platform's default text colour, above "Thanks — our team will review this."
add({ id: 'report.done.sub', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, "doneSub:  { ...t.body, color: color.mute, textAlign: 'center' },"]] });
const RS_SAFETY: Needle = [RS, "backgroundColor: '#FEF3C7',"];
add({ id: 'report.safety.title', fg: '#92400E', on: 'sheetSafety', kind: 'text', at: [RS_SAFETY, [RS, "safetyTitle: { ...t.small, fontWeight: '700', color: '#92400E', marginBottom: 2 },"]] });
add({ id: 'report.safety.sub', fg: '#92400E', on: 'sheetSafety', kind: 'text', at: [RS_SAFETY, [RS, "safetySub:   { ...t.small, color: '#92400E', lineHeight: 16 },"]] });
add({ id: 'report.safety.link', fg: '#92400E', on: 'sheetSafety', kind: 'text', at: [RS_SAFETY, [RS, "safetyLink:  { ...t.small, color: '#92400E', fontWeight: '700', textDecorationLine: 'underline', marginTop: 4 },"]] });
add({ id: 'report.safety.icon', fg: '#B45309', on: 'sheetSafety', kind: 'decor', at: [RS_SAFETY, [RS, '<ShieldAlert size={16} color="#B45309" />']] }); // beside the banner's title
add({ id: 'report.block.label', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, "blockBtnLabel: { ...t.bodyStrong, color: color.signalStrong, fontWeight: '700' },"]] });
add({ id: 'report.block.outline', fg: color.signal, on: 'sheetPaperRaised', kind: 'decor', at: [[RS, /blockBtn: \{[^}]*borderColor: color\.signal,/]] }); // "Also block …" names the button
add({ id: 'report.block.busy', fg: atOpacity(color.signal, 0.45, color.paperRaised), on: 'sheetPaperRaised', kind: 'decor', at: [[RS, '? <ActivityIndicator size="small" color={color.signal} />'], [RS, 'style={[rs.blockBtn, blockBusy && rs.btnDisabled]}']] }); // disabled while blocking (1.4.3)
add({ id: 'report.done.button', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [RS, 'doneBtnLabel: { ...t.body, color: color.mute },']] });
// The safety photo: MediaPickerButton's icon button, the sheet it opens, and the picked photo's card.
const PB = SF_NESTED.photoButton;
add({ id: 'report.photoButton.icon', fg: color.ink, on: 'sheetPaperRaised', kind: 'ui', at: [[RS, '<MediaPickerButton'], [PB, /iconBtn: \{[^}]*backgroundColor: color\.paperRaised,/], [PB, '<ImageIcon size={22} color={isDisabled ? color.faint : color.ink} />']] });
add({ id: 'report.photoButton.disabled', fg: atOpacity(color.faint, 0.4, color.paperRaised), on: 'sheetPaperRaised', kind: 'decor', at: [[PB, 'disabled: {\n    opacity: 0.4,']] }); // after the one photo this policy allows (1.4.3)
const MS = SF_NESTED.sourceSheet;
const MS_SHEET: Needle = [MS, /sheet: \{\s*backgroundColor: color\.paperRaised,/];
const MS_CAMERA: Needle = [MS, "<View style={[s.iconCircle, { backgroundColor: color.signal + '18' }]}>"];
const MS_LIBRARY: Needle = [MS, "<View style={[s.iconCircle, { backgroundColor: color.deep + '18' }]}>"];
const MS_DENIED: Needle = [MS, 'opacity: 1, // was 0.7'];
add({ id: 'report.source.title', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [[PB, '<MediaSourceSheet'], MS_SHEET, [MS, /title: \{\s*\.\.\.t\.heading,\s*color: color\.ink,/]] });
add({ id: 'report.source.cameraIcon', fg: color.signal, on: 'sheetPrSignal18', kind: 'decor', at: [MS_CAMERA, [MS, '<Camera size={20} color={cameraDenied ? color.faint : color.signal} />']] }); // beside "Camera"
add({ id: 'report.source.cameraLoading', fg: color.signalStrong, was: color.signal, on: 'sheetPrSignal18', kind: 'ui', at: [MS_CAMERA, [MS, "{busy === 'camera' ? (\n                <ActivityIndicator size=\"small\" color={color.signalStrong} />"]] });
add({ id: 'report.source.libraryIcon', fg: color.deep, on: 'sheetPrDeep18', kind: 'decor', at: [MS_LIBRARY, [MS, '<ImageIcon size={20} color={libraryDenied ? color.faint : color.deep} />']] }); // beside "Photo Library"
add({ id: 'report.source.libraryLoading', fg: color.deep, on: 'sheetPrDeep18', kind: 'ui', at: [MS_LIBRARY, [MS, '<ActivityIndicator size="small" color={color.deep} />']] });
add({ id: 'report.source.label', fg: color.ink, on: 'sheetPaperRaised', kind: 'text', at: [MS_SHEET, [MS, /rowLabel: \{\s*\.\.\.t\.bodyStrong,\s*color: color\.ink,/]] });
add({ id: 'report.source.sub', fg: color.mute, was: color.faint, on: 'sheetPaperRaised', kind: 'text', at: [MS_SHEET, [MS, /rowSub: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'report.source.deniedLabel', fg: color.mute, was: atOpacity(color.mute, 0.7, color.paperRaised), on: 'sheetPaperRaised', kind: 'text', at: [MS_DENIED, [MS, /rowLabelDenied: \{\s*color: color\.mute,/]] });
add({ id: 'report.source.deniedSub', fg: color.mute, was: atOpacity(color.faint, 0.7, color.paperRaised), on: 'sheetPaperRaised', kind: 'text', at: [MS_DENIED, [MS, /rowSub: \{\s*\.\.\.t\.small,\s*color: color\.mute,/]] });
add({ id: 'report.source.deniedSettings', fg: color.ink, was: atOpacity(color.ink, 0.7, color.paperRaised), on: 'sheetHaze', wasOn: 'sheetDeniedSettingsWas', kind: 'text', at: [MS_DENIED, [MS, /settingsBtn: \{[^}]*backgroundColor: color\.haze,/], [MS, /settingsBtnText: \{[^}]*color: color\.ink,/]] });
add({ id: 'report.source.deniedIcon', fg: color.faint, on: 'sheetPrSignal18', kind: 'decor', at: [MS_DENIED, [MS, '<Camera size={20} color={cameraDenied ? color.faint : color.signal} />']] }); // beside the denied row's label
add({ id: 'report.source.cancel', fg: color.mute, on: 'sheetPaperRaised', kind: 'text', at: [MS_SHEET, [MS, /cancelText: \{\s*\.\.\.t\.body,\s*color: color\.mute,/]] });
add({ id: 'report.source.cancelIcon', fg: color.mute, on: 'sheetPaperRaised', kind: 'decor', at: [[MS, '<X size={16} color={color.mute} />']] }); // beside "Cancel"
const TR = SF_NESTED.tray;
const TR_SCRIM: Needle = [TR, /uploadOverlay: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.55\)',/];
const TR_REMOVE: Needle = [TR, /removeBtn: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.55\)',/];
const TR_ERROR: Needle = [TR, /errorOverlay: \{[^}]*backgroundColor: 'rgba\(255,77,46,0\.6\)',/];
add({ id: 'report.tray.remove.photoFloor', fg: '#FFFFFF', on: 'trayScrimPhoto', kind: 'ui', at: [[RS, '<MediaAttachmentTray'], TR_REMOVE, [TR, '<X size={12} color="#fff" />']] });
add({ id: 'report.tray.removeOnError.photoFloor', fg: '#FFFFFF', on: 'trayRemoveOnErrorPhoto', kind: 'ui', at: [TR_ERROR, TR_REMOVE, [TR, '<X size={12} color="#fff" />']] });
add({ id: 'report.tray.uploading.photoFloor', fg: '#FFFFFF', on: 'trayScrimPhoto', kind: 'ui', at: [TR_SCRIM, [TR, '<ActivityIndicator size="small" color="#fff" testID={`upload-spinner-${item.id}`} />']] });
add({ id: 'report.tray.progress.photoFloor', fg: '#FFFFFF', on: 'trayTrackPhoto', wasOn: 'trayTrackPhotoWas', kind: 'ui', at: [TR_SCRIM, [TR, /progressBar: \{[^}]*backgroundColor: 'rgba\(17,17,15,0\.4\)',/], [TR, /progressFill: \{[^}]*backgroundColor: '#fff',/]] });
add({ id: 'report.tray.cancel.photoFloor', fg: '#FFFFFF', on: 'trayCancelPhoto', kind: 'ui', at: [TR_SCRIM, [TR, /cancelBtn: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.45\)',/], [TR, '<X size={10} color="#fff" />']] });
add({ id: 'report.tray.retry.photoFloor', fg: '#FFFFFF', on: 'trayRetryPhoto', kind: 'text', at: [TR_ERROR, [TR, /retryBtn: \{[^}]*backgroundColor: 'rgba\(0,0,0,0\.45\)',/], [TR, /retryText: \{\s*color: '#fff',/]] });
add({ id: 'report.tray.retryIcon.photoFloor', fg: '#FFFFFF', on: 'trayRetryPhoto', kind: 'decor', at: [TR_ERROR, [TR, '<RefreshCw size={14} color="#fff" />']] }); // beside "Retry"
add({ id: 'report.tray.errorText', fg: color.signalStrong, was: color.signal, on: 'sheetPaperRaised', kind: 'text', at: [RS_SHEET, [TR, /errorText: \{[^}]*color: color\.signalStrong,/]] });
