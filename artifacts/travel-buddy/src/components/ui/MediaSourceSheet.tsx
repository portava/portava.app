/**
 * MediaSourceSheet — shared source-chooser bottom sheet used by every
 * media-capable composer (Memories, Events, Postcards, Highlights, …).
 *
 * Opens as a Modal slide-up with three rows:
 *   • Camera        — take a new photo or record a video
 *   • Photo Library — browse existing photos / videos
 *   • Cancel
 *
 * Handles permissions internally:
 *   - Permission requested only when the user taps a source row.
 *   - If denied: the row stays visible but a "Enable in Settings" note
 *     appears; the other source remains fully accessible.
 *   - The sheet never crashes; every permission/picker edge case is caught.
 *
 * Web: Camera row is hidden (browser capture via <input> is unreliable on
 * desktop); Library row uses a hidden <input type="file"> fallback.
 *
 * Props:
 *   visible          — controlled open/close
 *   onClose()        — called when the sheet should close (cancel or after pick)
 *   onResult(asset)  — called with the selected ImagePickerAsset; sheet closes
 *   allowsVideo      — whether to offer video in addition to photos (default true)
 *   videoMaxDuration — seconds; passed to the picker (default 60)
 *   title            — optional label shown at the top of the sheet
 */
import React, { useState } from 'react';
import {
  Alert, Modal, View, Text, Pressable, StyleSheet,
  ActivityIndicator, Linking, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Camera, ImageIcon, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { VideoStoryTrimSheet } from './VideoStoryTrimSheet.tsx';

export interface MediaSourceSheetProps {
  visible: boolean;
  onClose: () => void;
  onResult: (asset: ImagePicker.ImagePickerAsset) => void;
  allowsVideo?: boolean;
  videoMaxDuration?: number;
  title?: string;
  /** When true the picker opens an in-picker crop editor after selection. */
  allowsEditing?: boolean;
  /** Aspect ratio [width, height] for the crop editor; only used when allowsEditing=true. */
  aspect?: [number, number];
  /**
   * When true, video picks are intercepted by a post-pick 9:16 crop-preview
   * sheet before being forwarded to onResult. Has no effect on image picks
   * or on web (file-input path). Replaces in-picker crop for video — keep
   * this in sync with the `effectiveAllowsEditing` guard below.
   */
  storyVideoTrim?: boolean;
}

export function MediaSourceSheet({
  visible,
  onClose,
  onResult,
  allowsVideo = true,
  videoMaxDuration = 60,
  title = 'Add media',
  allowsEditing = false,
  aspect,
  storyVideoTrim = false,
}: MediaSourceSheetProps) {
  const [busy, setBusy] = useState<'camera' | 'library' | null>(null);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [libraryDenied, setLibraryDenied] = useState(false);
  // Holds a video asset awaiting the post-pick 9:16 confirm step.
  const [pendingVideoAsset, setPendingVideoAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);

  // Platform limitation: expo-image-picker's allowsEditing / aspect is silently
  // ignored for video assets on iOS (the OS controls video trimming separately).
  // When video picks are enabled we suppress the crop editor entirely — showing
  // a crop UI that does nothing for the picked asset would confuse users.
  // Callers that need cropping AND video support should either restrict
  // allowedTypes to ['images'] in their policy, or apply the crop post-pick.
  const effectiveAllowsEditing = allowsEditing && !allowsVideo;

  // ── Web file-input fallback ────────────────────────────────────────────────
  function pickViaFileInput() {
    const accept = allowsVideo ? 'image/*,video/*' : 'image/*';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const uri = URL.createObjectURL(file);
      const isVideo = file.type.startsWith('video/');
      // Synthesise a minimal ImagePickerAsset so callers get a uniform type
      const synth: ImagePicker.ImagePickerAsset = {
        uri,
        mimeType: file.type,
        fileName: file.name,
        fileSize: file.size,
        width: 0,
        height: 0,
        type: isVideo ? 'video' : 'image',
        assetId: null,
        base64: null,
        exif: null,
        duration: null,
        pairedVideoAsset: undefined,
      } as unknown as ImagePicker.ImagePickerAsset;

      // Web: expo-av is unavailable so VideoStoryTrimSheet cannot render a
      // preview. Instead, show a lightweight Alert warning the user that their
      // video will be cropped to 9:16, giving them a chance to cancel and
      // pick a better-framed file.
      if (storyVideoTrim && isVideo) {
        Alert.alert(
          'Video will display in 9:16',
          'Stories are shown in portrait 9:16 format. Your video will be cropped to fit — any content outside the centre frame may be cut off.',
          [
            { text: 'Choose different file', style: 'cancel', onPress: () => URL.revokeObjectURL(uri) },
            { text: 'Post anyway', onPress: () => onResult(synth) },
          ],
        );
        return;
      }

      onResult(synth);
      onClose();
    };
    input.click();
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  async function handleCamera() {
    setBusy('camera');
    setCameraDenied(false);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setCameraDenied(true);
        setBusy(null);
        return;
      }
      const mediaTypes: ImagePicker.MediaType[] = allowsVideo
        ? ['images', 'videos']
        : ['images'];
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes,
        quality: 0.92,
        videoMaxDuration: allowsVideo ? videoMaxDuration : undefined,
        allowsEditing: effectiveAllowsEditing,
        aspect: effectiveAllowsEditing ? aspect : undefined,
      });
      setBusy(null);
      if (result.canceled || !result.assets?.[0]) return;
      deliverAsset(result.assets[0]);
    } catch {
      setBusy(null);
    }
  }

  // ── Library ───────────────────────────────────────────────────────────────
  async function handleLibrary() {
    if (Platform.OS === 'web') {
      pickViaFileInput();
      onClose();
      return;
    }
    setBusy('library');
    setLibraryDenied(false);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setLibraryDenied(true);
        setBusy(null);
        return;
      }
      // iOS 14+: user granted access to a limited selection — offer to expand.
      if (Platform.OS === 'ios' && (perm as any).accessPrivileges === 'limited') {
        // Don't block the pick; just surface the upgrade option after.
        // We show the alert after the picker closes so it doesn't fight the sheet.
        setTimeout(() => {
          Alert.alert(
            'Limited photo access',
            'You\'ve given access to a limited set of photos. Expand your selection or grant full access in Settings.',
            [
              { text: 'Select more photos', onPress: () => ImagePicker.requestMediaLibraryPermissionsAsync().catch(() => {}) },
              { text: 'Allow full access', onPress: () => Linking.openSettings() },
              { text: 'Continue', style: 'cancel' },
            ],
          );
        }, 500);
      }
      const mediaTypes: ImagePicker.MediaType[] = allowsVideo
        ? ['images', 'videos']
        : ['images'];
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes,
        allowsEditing: effectiveAllowsEditing,
        aspect: effectiveAllowsEditing ? aspect : undefined,
        quality: 0.92,
        videoMaxDuration: allowsVideo ? videoMaxDuration : undefined,
      });
      setBusy(null);
      if (result.canceled || !result.assets?.[0]) return;
      deliverAsset(result.assets[0]);
    } catch {
      setBusy(null);
    }
  }

  // ── Asset delivery (with optional post-pick video crop step) ─────────────
  /**
   * Route a picked asset to onResult.
   * If storyVideoTrim is enabled and the asset is a video, hold it in state
   * so VideoStoryTrimSheet can show the 9:16 preview before confirming.
   * Image assets and web picks always go straight through.
   */
  function deliverAsset(asset: ImagePicker.ImagePickerAsset) {
    const isVideo = asset.type === 'video' || (asset.mimeType ?? '').startsWith('video/');
    if (storyVideoTrim && isVideo && Platform.OS !== 'web') {
      // Keep the source sheet visible (so its scrim remains) and
      // show the trim preview on top — VideoStoryTrimSheet is a separate Modal.
      setPendingVideoAsset(asset);
      return;
    }
    onResult(asset);
    onClose();
  }

  function handleTrimConfirm(asset: ImagePicker.ImagePickerAsset) {
    setPendingVideoAsset(null);
    onResult(asset);
    onClose();
  }

  function handleTrimReject() {
    // User wants to re-pick — dismiss the trim sheet but keep the source
    // sheet open so they can choose again immediately.
    setPendingVideoAsset(null);
  }

  function handleClose() {
    if (busy) return; // don't close while a picker is open
    setCameraDenied(false);
    setLibraryDenied(false);
    onClose();
  }

  const mediaLabel = allowsVideo ? 'photo or video' : 'photo';

  return (
    <>
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={s.scrim} onPress={handleClose} />

      <View style={s.sheet}>
        {/* Handle bar */}
        <View style={s.handle} />

        {/* Title */}
        <Text style={s.title}>{title}</Text>

        {/* Camera row — hidden on web (unreliable for desktop browsers) */}
        {Platform.OS !== 'web' && (
          <Pressable
            style={[s.row, cameraDenied && s.rowDenied]}
            onPress={handleCamera}
            disabled={!!busy}
            accessibilityRole="button"
            accessibilityLabel={`Take ${mediaLabel} with camera`}
          >
            <View style={[s.iconCircle, { backgroundColor: color.signal + '18' }]}>
              {busy === 'camera' ? (
                <ActivityIndicator size="small" color={color.signal} />
              ) : (
                <Camera size={20} color={cameraDenied ? color.faint : color.signal} />
              )}
            </View>
            <View style={s.rowText}>
              <Text style={[s.rowLabel, cameraDenied && s.rowLabelDenied]}>
                Camera
              </Text>
              <Text style={s.rowSub}>
                {cameraDenied
                  ? 'Camera access denied — tap to open Settings'
                  : `Take a new ${mediaLabel}`}
              </Text>
            </View>
            {cameraDenied && (
              <Pressable
                onPress={() => Linking.openSettings()}
                hitSlop={8}
                style={s.settingsBtn}
              >
                <Text style={s.settingsBtnText}>Settings</Text>
              </Pressable>
            )}
          </Pressable>
        )}

        {/* Divider */}
        {Platform.OS !== 'web' && <View style={s.divider} />}

        {/* Library row */}
        <Pressable
          style={[s.row, libraryDenied && s.rowDenied]}
          onPress={handleLibrary}
          disabled={!!busy}
          accessibilityRole="button"
          accessibilityLabel={`Choose ${mediaLabel} from library`}
        >
          <View style={[s.iconCircle, { backgroundColor: color.deep + '18' }]}>
            {busy === 'library' ? (
              <ActivityIndicator size="small" color={color.deep} />
            ) : (
              <ImageIcon size={20} color={libraryDenied ? color.faint : color.deep} />
            )}
          </View>
          <View style={s.rowText}>
            <Text style={[s.rowLabel, libraryDenied && s.rowLabelDenied]}>
              {Platform.OS === 'web' ? 'Choose file' : 'Photo Library'}
            </Text>
            <Text style={s.rowSub}>
              {libraryDenied
                ? 'Library access denied — tap to open Settings'
                : Platform.OS === 'web'
                  ? `Select a ${mediaLabel} from your device`
                  : `Choose an existing ${mediaLabel}`}
            </Text>
          </View>
          {libraryDenied && (
            <Pressable
              onPress={() => Linking.openSettings()}
              hitSlop={8}
              style={s.settingsBtn}
            >
              <Text style={s.settingsBtnText}>Settings</Text>
            </Pressable>
          )}
        </Pressable>

        {/* Cancel */}
        <Pressable
          style={s.cancelRow}
          onPress={handleClose}
          disabled={!!busy}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <X size={16} color={color.mute} />
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>

    {/* Post-pick 9:16 crop-preview for story videos */}
    <VideoStoryTrimSheet
      visible={pendingVideoAsset !== null}
      asset={pendingVideoAsset}
      onConfirm={handleTrimConfirm}
      onReject={handleTrimReject}
    />
    </>
  );
}

const s = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: space.lg,
    paddingBottom: 36,
    paddingTop: space.md,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  title: {
    ...t.heading,
    color: color.ink,
    marginBottom: space.lg,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    minHeight: 64,
  },
  rowDenied: {
    opacity: 0.7,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  rowLabelDenied: {
    color: color.mute,
  },
  rowSub: {
    ...t.small,
    color: color.faint,
  },
  settingsBtn: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    backgroundColor: color.haze,
    borderRadius: radius.sm,
  },
  settingsBtnText: {
    ...t.small,
    fontWeight: '600',
    color: color.ink,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginVertical: 2,
  },
  cancelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.md,
    paddingVertical: space.md,
    minHeight: 48,
  },
  cancelText: {
    ...t.body,
    color: color.mute,
    fontWeight: '500',
  },
});
