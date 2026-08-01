/**
 * MediaPickerButton — trigger button that opens MediaSourceSheet so users
 * can choose "Take Photo" or "Choose from Library".
 *
 * Sheet state is managed internally; callers only need to pass `onPickResult`,
 * `policy`, and `canAddMore` from their composer.
 *
 * All policy behaviour (story-video crop, effectiveAllowsEditing, video max
 * duration, aspect ratio) is forwarded to MediaSourceSheet unchanged.
 *
 * For full-size "pick area" layouts (memory/create), use `variant="area"`.
 */
import React, { useState } from 'react';
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
  /**
   * State + methods from useMediaComposer. Only `policy`, `onPickResult`, and
   * `canAddMore` are consumed; sheet state is managed internally by this
   * component.
   */
  composer: Pick<
    UseMediaComposerReturn,
    'policy' | 'onPickResult' | 'canAddMore'
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
  const { policy, onPickResult, canAddMore } = composer;
  const allowsVideo = policyAllowsVideo(policy);

  // Sheet state is managed here so callers don't need to thread it through
  // their composer.
  const [sheetVisible, setSheetVisible] = useState(false);

  const isDisabled = disabled || !canAddMore;

  return (
    <>
      {variant === 'area' ? (
        <Pressable
          style={[s.area, isDisabled && s.disabled]}
          onPress={() => setSheetVisible(true)}
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
            onPress={() => setSheetVisible(true)}
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
        onClose={() => setSheetVisible(false)}
        onResult={(asset) => {
          setSheetVisible(false);
          onPickResult(asset);
        }}
        allowsVideo={allowsVideo}
        videoMaxDuration={policy.videoMaxDuration ?? 60}
        title={sheetTitle ?? (allowsVideo ? 'Add photo or video' : 'Add photo')}
        allowsEditing={policy.allowsEditing}
        aspect={policy.editAspect}
        storyVideoTrim={policy.requireStoryVideoCrop}
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
