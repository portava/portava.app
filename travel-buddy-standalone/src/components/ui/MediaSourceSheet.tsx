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
  Modal, View, Text, Pressable, StyleSheet,
  ActivityIndicator, Linking, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Camera, ImageIcon, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export interface MediaSourceSheetProps {
  visible: boolean;
  onClose: () => void;
  onResult: (asset: ImagePicker.ImagePickerAsset) => void;
  allowsVideo?: boolean;
  videoMaxDuration?: number;
  title?: string;
}

export function MediaSourceSheet({
  visible,
  onClose,
  onResult,
  allowsVideo = true,
  videoMaxDuration = 60,
  title = 'Add media',
}: MediaSourceSheetProps) {
  const [busy, setBusy] = useState<'camera' | 'library' | null>(null);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [libraryDenied, setLibraryDenied] = useState(false);

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
      });
      setBusy(null);
      if (result.canceled || !result.assets?.[0]) return;
      onResult(result.assets[0]);
      onClose();
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
      const mediaTypes: ImagePicker.MediaType[] = allowsVideo
        ? ['images', 'videos']
        : ['images'];
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes,
        allowsEditing: false,
        quality: 0.92,
        videoMaxDuration: allowsVideo ? videoMaxDuration : undefined,
      });
      setBusy(null);
      if (result.canceled || !result.assets?.[0]) return;
      onResult(result.assets[0]);
      onClose();
    } catch {
      setBusy(null);
    }
  }

  function handleClose() {
    if (busy) return; // don't close while a picker is open
    setCameraDenied(false);
    setLibraryDenied(false);
    onClose();
  }

  const mediaLabel = allowsVideo ? 'photo or video' : 'photo';

  return (
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
