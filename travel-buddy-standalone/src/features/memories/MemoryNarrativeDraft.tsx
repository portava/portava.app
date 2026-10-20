import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as typography } from '../../theme/tokens.ts';
import { getMemoryNarrative } from '../../services/memoryNarrative.ts';
import type { MemoryOwnerRequest } from '../../services/memoryOwnerRequest.ts';

export function MemoryNarrativeDraft({ request, disabled, onUse }: {
  request: MemoryOwnerRequest;
  disabled: boolean;
  onUse: (summary: string) => void;
}) {
  const active = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const abort = () => { active.current?.abort(); active.current = null; };
    request.signal.addEventListener('abort', abort);
    return () => { abort(); request.signal.removeEventListener('abort', abort); };
  }, [request]);

  const cancel = () => {
    active.current?.abort(); active.current = null;
    setLoading(false); setSummary(null); setFailed(false);
  };

  const preview = async () => {
    if (disabled || active.current || request.signal.aborted || !request.isCurrent()) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true); setSummary(null); setFailed(false);
    const current = () => active.current === controller && !controller.signal.aborted
      && !request.signal.aborted && request.isCurrent();
    const result = await getMemoryNarrative({ ...request, signal: controller.signal, isCurrent: current });
    if (!current()) return;
    active.current = null;
    setLoading(false);
    if (result.ok) setSummary(result.summary);
    else setFailed(true);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.label}>Draft from saved details</Text>
      <Text style={styles.help}>A template-based draft, not AI. Review it for accuracy. It uses saved details, not unsaved edits.</Text>
      <Text style={styles.help}>Use draft replaces your caption here. You can edit it before choosing Save. Nothing is saved automatically.</Text>
      {!loading && summary === null && (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={() => { void preview(); }} style={styles.action}>
          <Text style={styles.actionText}>Preview draft</Text>
        </Pressable>
      )}
      {loading && <ActivityIndicator color={color.signal} accessibilityLabel="Loading draft" />}
      {failed && <Text style={styles.help} accessibilityRole="alert">Could not load a draft. Your caption has not changed.</Text>}
      {summary !== null && <Text style={styles.preview}>{summary}</Text>}
      {summary !== null && summary.length > 2000 && (
        <Text style={styles.help}>This draft is too long for a caption. Keep editing your caption instead.</Text>
      )}
      {summary !== null && summary.length <= 2000 && (
        <Pressable accessibilityRole="button" disabled={disabled} style={styles.action} onPress={() => {
          if (!request.signal.aborted && request.isCurrent()) { onUse(summary); cancel(); }
        }}>
          <Text style={styles.actionText}>Use draft</Text>
        </Pressable>
      )}
      {(loading || summary !== null) && (
        <Pressable accessibilityRole="button" onPress={cancel} style={styles.action}>
          <Text style={styles.actionText}>Cancel preview</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  label: { ...(typography.bodyStrong as object), color: color.ink },
  help: { ...(typography.small as object), color: color.mute },
  preview: { ...(typography.body as object), color: color.ink, backgroundColor: color.paperRaised,
    padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  action: { alignSelf: 'flex-start', paddingVertical: space.sm },
  actionText: { ...(typography.body as object), color: color.signal },
});
