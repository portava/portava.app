/**
 * Telegraph WP-08 / TEL-F07 — edit your own message.
 *
 * The sheet owns only the text box. Saving is the caller's `onSubmit`, which
 * goes through the canonical edit route (`editThreadMessage`, PATCH
 * /api/threads/:t/messages/:m): it keeps the previous body as a version, re-
 * checks active membership and sender, and refuses on an end-to-end encrypted
 * thread. The sheet closes ONLY when the server said yes; a refusal stays on
 * screen with the server's reason and the text the person typed, so nothing is
 * lost and nothing is claimed.
 *
 * Mirrors the server's own limits (trimmed, non-empty, ≤ 4000) so the Save
 * button is not offered for a body the server would refuse anyway, and is not
 * offered for an unchanged body, which would record a version identical to the
 * current text.
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View, ActivityIndicator } from 'react-native';
import { color } from '../../../theme/tokens.ts';
import { sheet } from './sheetStyles.ts';

export const EDIT_MAX_CHARS = 4000;

export interface EditMessageSheetProps {
  visible: boolean;
  initialBody: string;
  onClose: () => void;
  /** Resolve `ok: true` only when the server accepted the edit. */
  onSubmit: (body: string) => Promise<{ ok: boolean; message?: string }>;
}

export function canSaveEdit(draft: string, initialBody: string): boolean {
  const next = draft.trim();
  return next.length > 0 && next.length <= EDIT_MAX_CHARS && next !== initialBody.trim();
}

export function EditMessageSheet({ visible, initialBody, onClose, onSubmit }: EditMessageSheetProps) {
  const [draft, setDraft] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) { setDraft(initialBody); setError(null); setSaving(false); }
  }, [visible, initialBody]);

  if (!visible) return null;
  const allowed = canSaveEdit(draft, initialBody) && !saving;

  async function save() {
    if (!canSaveEdit(draft, initialBody) || saving) return;
    setSaving(true);
    setError(null);
    const r = await onSubmit(draft.trim());
    setSaving(false);
    if (r.ok) onClose();
    else setError(r.message ?? 'Your edit was not saved. The message is unchanged.');
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sheet.overlay} onPress={saving ? undefined : onClose} />
      <View style={sheet.sheet} testID="telegraph-edit-sheet">
        <View style={sheet.handle} />
        <Text style={sheet.title}>Edit message</Text>
        <Text style={sheet.sub}>Everyone in the conversation sees that it was edited, and can see what it said before.</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          maxLength={EDIT_MAX_CHARS}
          editable={!saving}
          style={sheet.input}
          accessibilityLabel="Message text"
          testID="telegraph-edit-input"
        />
        {error ? <Text style={sheet.error} testID="telegraph-edit-error">{error}</Text> : null}
        <Pressable
          style={[sheet.primaryBtn, !allowed && sheet.btnDisabled]}
          disabled={!allowed}
          onPress={() => { void save(); }}
          accessibilityRole="button"
          accessibilityState={{ disabled: !allowed }}
          testID="telegraph-edit-save"
        >
          {saving ? <ActivityIndicator color={color.onInk} /> : <Text style={sheet.btnLabel}>Save edit</Text>}
        </Pressable>
        <Pressable style={sheet.secondaryBtn} onPress={onClose} disabled={saving} accessibilityRole="button">
          <Text style={sheet.secondaryLabel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

export default EditMessageSheet;
