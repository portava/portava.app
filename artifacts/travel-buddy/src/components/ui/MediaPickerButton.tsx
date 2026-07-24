/**
 * MediaPickerButton — trigger button that opens MediaSourceSheet via
 * useMediaComposer. Renders camera + image-library icons side by side.
 *
 * The composer must pass the hook's `openSheet` + `sheetVisible` +
 * `onPickResult` + `closeSheet` props so this component delegates all state
 * back to useMediaComposer.
 *
 * For full-size "pick area" layouts (memory/create), use the `variant="area"`
 * prop which renders the dashed-border pick zone.
 */
import React from 'react';
import {
  View, Text, Pressable, StyleSheet,
} from 'react-native';
import { Camera, ImageIcon } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { MediaSourceSheet } from './MediaSourceSheet.tsx';
import type { UseMediaComposerReturn } from '../../hooks/useMediaComposer.ts';
import { policyAllowsVideo } from '../../lib/contentMediaPolicy.ts';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MediaPickerButtonProps {
  /** State + methods from useMediaComposer. */
  composer: Pick<
    UseMediaComposerReturn,
    'policy' | 'sheetVisible' | 'openSheet' | 'closeSheet' | 'onPickResult' | 'canAddMore'
  >;
  /** Visual variant. 'icon' = compact row of icons. 'area' = dashed pick zone. */
  variant?: 'icon' | 'area';
  /** Label shown in 'area' variant. */
  label?: string;
  /** Optional sheet title override. */
  sheetTitle?: string;
  disabled?: boolean;
  testID?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MediaPickerButton({
  composer,
  variant = 'icon',
  label,
  sheetTitle,
  disabled = false,
  testID,
}: MediaPickerButtonProps) {
  const { policy, sheetVisible, openSheet, closeSheet, onPickResult, canAddMore } = composer;
  const allowsVideo = policyAllowsVideo(policy);

  const isDisabled = disabled || !canAddMore;

  return (
    <>
      {variant === 'area' ? (
        <Pressable
          style={[s.area, isDisabled && s.disabled]}
          onPress={openSheet}
          disabled={isDisabled}
          testID={testID ?? 'media-picker-button'}
          accessibilityRole="button"
          accessibilityLabel={label ?? 'Add media'}
        >
          <View style={s.areaIconRow}>
            <ImageIcon size={20} color={isDisabled ? color.faint : color.signal} />
            <Camera size={20} color={isDisabled ? color.faint : color.signal} />
          </View>
          <Text style={[s.areaLabel, isDisabled && s.areaLabelDisabled]}>
            {label ?? (allowsVideo ? 'Add photos or videos' : 'Add photos')}
          </Text>
        </Pressable>
      ) : (
        <View style={s.iconRow}>
          <Pressable
            style={[s.iconBtn, isDisabled && s.disabled]}
            onPress={openSheet}
            disabled={isDisabled}
            testID={testID ?? 'media-picker-button'}
            accessibilityRole="button"
            accessibilityLabel={label ?? 'Add media'}
          >
            <ImageIcon size={22} color={isDisabled ? color.faint : color.ink} />
          </Pressable>
        </View>
      )}

      <MediaSourceSheet
        visible={sheetVisible}
        onClose={closeSheet}
        onResult={onPickResult}
        allowsVideo={allowsVideo}
        videoMaxDuration={policy.videoMaxDuration ?? 60}
        title={sheetTitle ?? (allowsVideo ? 'Add photo or video' : 'Add photo')}
        allowsEditing={policy.allowsEditing}
        aspect={policy.editAspect}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = StyleSheet.create({
  iconRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  area: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.haze,
    borderRadius: radius.lg,
    paddingVertical: space.xl,
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
  },
  areaIconRow: {
    flexDirection: 'row',
    gap: space.md,
  },
  areaLabel: {
    ...t.body,
    color: color.signal,
    fontWeight: '600',
  },
  areaLabelDisabled: {
    color: color.faint,
  },
  disabled: {
    opacity: 0.4,
  },
});
