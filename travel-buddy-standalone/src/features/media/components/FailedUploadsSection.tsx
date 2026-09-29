/**
 * FailedUploadsSection — the owner's failed uploads, each with Retry, inside
 * the My World lens (testing-mode WP-17, flow MED-F25).
 *
 * OWNER-ONLY: the server lists the caller's own assets. HONEST STATES: while
 * loading, and when the owner has no failed uploads, it renders nothing (the
 * lens is not about failures); a failed read says it could not check, with
 * Retry — it never implies "no failures". When the server says a retry cannot
 * be queued now, the section says so and offers no button that would be
 * refused. A retried upload leaves the list only after the server queued it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import {
  fetchFailedUploads, retryFailedUpload, retryErrorCopy,
  type FailedUpload,
} from '../../../services/mediaUploadRetry.ts';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; items: FailedUpload[]; retryAvailable: boolean };

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function FailedUploadsSection() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [queued, setQueued] = useState(0);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoad({ state: 'loading' });
    const r = await fetchFailedUploads();
    if (mine !== seq.current) return;
    setLoad(r.ok ? { state: 'ready', items: r.data.items, retryAvailable: r.data.retryAvailable } : { state: 'error' });
  }, []);

  useEffect(() => { void reload(); return () => { seq.current += 1; }; }, [reload]);

  const retry = async (item: FailedUpload) => {
    setBusy(item.id);
    setNotice(null);
    const r = await retryFailedUpload(item.id);
    setBusy(null);
    if (!r.ok) { setNotice({ id: item.id, text: retryErrorCopy(r.error) }); return; }
    setQueued((n) => n + 1);
    setLoad((prev) => (prev.state === 'ready' ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : prev));
  };

  if (load.state === 'loading') return null;
  if (load.state === 'error') {
    return (
      <View style={styles.section} testID="failed-uploads-error">
        <Text style={styles.body}>Couldn&apos;t check for failed uploads right now.</Text>
        <Pressable onPress={() => void reload()} accessibilityRole="button" accessibilityLabel="Check failed uploads again">
          <Text style={styles.action}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (load.items.length === 0) {
    return queued > 0 ? (
      <View style={styles.section} testID="failed-uploads-queued">
        <Text style={styles.body}>Queued for processing again. It will appear in your world when it is ready.</Text>
      </View>
    ) : null;
  }
  return (
    <View style={styles.section} testID="failed-uploads">
      <Text style={styles.title}>{load.items.length === 1 ? '1 upload failed' : `${load.items.length} uploads failed`}</Text>
      <Text style={styles.body}>
        {load.retryAvailable
          ? 'Processing did not finish for these. Retry to process them again.'
          : 'Processing did not finish for these. Retrying is not available right now — they are kept, not lost.'}
      </Text>
      {load.items.map((item) => (
        <View key={item.id} style={styles.row} testID={`failed-upload-${item.id}`}>
          <Text style={styles.rowText}>{item.mediaType === 'video' ? 'Video' : 'Photo'}{when(item.createdAt) ? ` · ${when(item.createdAt)}` : ''}</Text>
          {load.retryAvailable ? (
            busy === item.id ? <ActivityIndicator color={color.onInk} /> : (
              <Pressable onPress={() => void retry(item)} accessibilityRole="button" accessibilityLabel="Retry this upload" testID={`failed-upload-retry-${item.id}`}>
                <Text style={styles.action}>Retry</Text>
              </Pressable>
            )
          ) : null}
          {notice?.id === item.id ? <Text style={styles.notice} testID={`failed-upload-notice-${item.id}`}>{notice.text}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginHorizontal: space.lg, marginBottom: space.md, padding: space.lg, borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.05)', gap: space.sm,
  },
  title: { color: color.onInk, fontSize: 15, fontWeight: '800' },
  body: { color: color.onInkMute, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.md },
  rowText: { color: color.onInk, fontSize: 13, flex: 1 },
  action: { color: color.signal, fontSize: 14, fontWeight: '700' },
  notice: { color: color.warn, fontSize: 12, width: '100%' },
});

export default FailedUploadsSection;
