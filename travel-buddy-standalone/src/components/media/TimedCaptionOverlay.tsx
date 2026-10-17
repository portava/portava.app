import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { TimedCaptionCue } from '../../services/media/captions.ts';

export interface CaptionPlaybackStatus { isLoaded: boolean; positionMillis?: number }

export function TimedCaptionOverlay({ cues, status }: { cues: TimedCaptionCue[]; status: CaptionPlaybackStatus | null }) {
  const position = status?.isLoaded ? status.positionMillis : undefined;
  if (position === undefined || !Number.isFinite(position) || position < 0) return null;
  const text = cues.filter((cue) => cue.startMs <= position && position < cue.endMs).map((cue) => cue.text).join('\n');
  if (!text) return null;
  return <View pointerEvents="none" style={styles.overlay}><Text testID="timed-caption" accessible accessibilityLabel={text} style={styles.text}>{text}</Text></View>;
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', bottom: 76, left: 16, right: 16, alignItems: 'center' },
  text: { color: '#fff', backgroundColor: '#111', fontSize: 18, lineHeight: 25, padding: 8, borderRadius: 4, textAlign: 'center' },
});
