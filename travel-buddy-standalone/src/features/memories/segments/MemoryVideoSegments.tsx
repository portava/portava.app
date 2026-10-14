/**
 * MemoryVideoSegments — the marked parts of ONE video on a Memory (census-
 * highlights-memories H184, §20 "Video scenes as logical segments without
 * duplicating originals"; server: routes/memorySegments.ts, migration 3809).
 *
 *   - Everyone the server serves a part to sees it as a chip under the video;
 *     pressing a chip plays exactly that window of the SAME video
 *     (SharedVideoPlayer with `segment`: start at startMs, stop at endMs).
 *     Nothing is cut, copied or uploaded — the player is handed the video's own
 *     reference, the one the Memory detail already carries.
 *   - The owner also gets an in/out editor ("Mark a part": start, end, an
 *     optional label) and a remove button on each chip.
 *
 * Renders NOTHING for a photo, while the server has no segments table (3809 not
 * applied: `available: false`), for a Memory the server will not show this
 * viewer, and for a viewer when the video has no parts. A failed read is shown
 * as a failure with a retry — never as "no parts".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Scissors, X } from 'lucide-react-native';
import { aspect, color, space, radius, type as t } from '../../../theme/tokens.ts';
import { SharedVideoPlayer } from '../../../components/ui/SharedVideoPlayer.tsx';
import {
  SEGMENT_LABEL_MAX,
  isVideoItemType,
  loadMemorySegments,
  markVideoSegment,
  parseClock,
  removeVideoSegment,
  segmentTitle,
  type SegmentsRead,
  type VideoSegment,
} from './memorySegmentsApi.ts';

export interface MemoryVideoSegmentsProps {
  memoryId: string;
  item: { id: string; mediaUrl: string; mediaType: string };
  isOwner: boolean;
}

export function MemoryVideoSegments({ memoryId, item, isOwner }: MemoryVideoSegmentsProps) {
  const isVideo = isVideoItemType(item.mediaType);
  const [read, setRead] = useState<SegmentsRead | null>(null);
  const [playing, setPlaying] = useState<VideoSegment | null>(null);
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRead(await loadMemorySegments(memoryId));
  }, [memoryId]);

  useEffect(() => {
    if (!isVideo) return undefined;
    let alive = true;
    void loadMemorySegments(memoryId).then((r) => { if (alive) setRead(r); });
    return () => { alive = false; };
  }, [memoryId, isVideo]);

  const save = useCallback(async () => {
    const startMs = parseClock(start);
    const endMs = parseClock(end);
    if (startMs === null || endMs === null) { setMessage('Use minutes and seconds, like 0:05.'); return; }
    if (startMs >= endMs) { setMessage('A part must start before it ends.'); return; }
    const trimmed = label.trim();
    setSaving(true);
    const out = await markVideoSegment(memoryId, item.id, { startMs, endMs, label: trimmed.length > 0 ? trimmed : null });
    setSaving(false);
    if (!out.ok) { setMessage(out.message); return; }
    setRead((prev) => (prev && prev.state === 'ok' ? { ...prev, segments: [...prev.segments, out.value].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs) } : prev));
    setEditing(false); setStart(''); setEnd(''); setLabel(''); setMessage(null);
  }, [start, end, label, memoryId, item.id]);

  const confirmRemove = useCallback((seg: VideoSegment) => {
    Alert.alert('Remove this part?', 'Only the marker goes. The video stays as it is.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          const out = await removeVideoSegment(memoryId, seg.id);
          if (!out.ok) { Alert.alert('Could not remove', out.message); return; }
          setPlaying((p) => (p?.id === seg.id ? null : p));
          setRead((prev) => (prev && prev.state === 'ok' ? { ...prev, segments: prev.segments.filter((x) => x.id !== seg.id) } : prev));
        },
      },
    ]);
  }, [memoryId]);

  if (!isVideo || !read || read.state === 'not_found') return null;
  if (read.state === 'error') {
    return (
      <View style={s.wrap} testID={`memory-segments-error-${item.id}`}>
        <Text style={s.note}>The marked parts of this video could not be loaded.</Text>
        <Pressable onPress={() => { void load(); }} accessibilityRole="button" testID={`memory-segments-retry-${item.id}`} hitSlop={6}>
          <Text style={s.action}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (!read.available) return null;
  const mine = read.segments.filter((x) => x.itemId === item.id);
  if (mine.length === 0 && !isOwner) return null;

  return (
    <View style={s.wrap} testID={`memory-segments-${item.id}`}>
      {mine.length > 0 ? (
        <View style={s.chips}>
          {mine.map((seg) => (
            <View key={seg.id} style={[s.chip, playing?.id === seg.id && s.chipOn]}>
              <Pressable
                onPress={() => setPlaying(seg)}
                accessibilityRole="button"
                accessibilityLabel={`Play ${segmentTitle(seg)}`}
                testID={`memory-segment-chip-${seg.id}`}
              >
                <Text style={s.chipText} numberOfLines={1}>{segmentTitle(seg)}</Text>
              </Pressable>
              {isOwner ? (
                <Pressable
                  onPress={() => confirmRemove(seg)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${segmentTitle(seg)}`}
                  testID={`memory-segment-remove-${seg.id}`}
                  hitSlop={8}
                >
                  <X size={14} color={color.ink} />
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {playing ? (
        <View style={s.playerWrap} testID="memory-segment-playing">
          <SharedVideoPlayer
            uri={playing.mediaUrl}
            segment={{ startMs: playing.startMs, endMs: playing.endMs }}
            autoplay
            style={s.player}
          />
          <Pressable onPress={() => setPlaying(null)} accessibilityRole="button" testID="memory-segment-close" hitSlop={6}>
            <Text style={s.action}>Close</Text>
          </Pressable>
        </View>
      ) : null}

      {isOwner && !editing ? (
        <Pressable
          style={s.addBtn}
          onPress={() => { setEditing(true); setMessage(null); }}
          accessibilityRole="button"
          testID={`memory-segment-add-${item.id}`}
        >
          <Scissors size={15} color={color.ink} />
          <Text style={s.action}>Mark a part of this video</Text>
        </Pressable>
      ) : null}

      {isOwner && editing ? (
        <View style={s.editor} testID={`memory-segment-editor-${item.id}`}>
          <View style={s.row}>
            <TextInput
              value={start}
              onChangeText={setStart}
              placeholder="Start 0:00"
              placeholderTextColor={color.mute}
              accessibilityLabel="Start time, minutes and seconds"
              testID="memory-segment-start"
              style={s.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              value={end}
              onChangeText={setEnd}
              placeholder="End 0:10"
              placeholderTextColor={color.mute}
              accessibilityLabel="End time, minutes and seconds"
              testID="memory-segment-end"
              style={s.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Label (optional) — shown to whoever sees this video"
            placeholderTextColor={color.mute}
            accessibilityLabel="Label for this part"
            testID="memory-segment-label"
            style={s.input}
            maxLength={SEGMENT_LABEL_MAX}
          />
          <View style={s.row}>
            <Pressable onPress={() => { void save(); }} disabled={saving} accessibilityRole="button" testID="memory-segment-save" style={s.saveBtn}>
              {saving ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={s.action}>Save</Text>}
            </Pressable>
            <Pressable onPress={() => { setEditing(false); setMessage(null); }} accessibilityRole="button" testID="memory-segment-cancel" hitSlop={6}>
              <Text style={s.note}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {message ? <Text style={s.message} testID="memory-segment-message">{message}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm, backgroundColor: color.paperRaised },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    paddingHorizontal: space.md, paddingVertical: space.xs,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  chipOn: { borderColor: color.ink },
  chipText: { ...(t.small as object), color: color.ink, maxWidth: 220 },
  playerWrap: { gap: space.xs },
  player: { width: '100%', aspectRatio: aspect.wide },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  action: { ...(t.small as object), color: color.ink, fontWeight: '600' },
  note: { ...(t.small as object), color: color.mute },
  message: { ...(t.small as object), color: color.ink },
  editor: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: {
    ...(t.small as object), color: color.ink, flex: 1,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm,
    paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: color.paper,
  },
  saveBtn: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: color.ink },
});
