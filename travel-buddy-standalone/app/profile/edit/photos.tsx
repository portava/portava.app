/**
 * Photos & Appearance — avatar + cover with immediate save flow.
 * Copied verbatim from the legacy edit-profile monolith:
 * pickAvatar/pickCover (ImagePicker), the optimizing → uploading photoPhase,
 * renderAvatarImage/renderCoverImage compression, uploadAvatar/uploadCover,
 * updateMyProfile({avatarUrl/coverUrl}), and the deleteOrphanedAvatar/
 * deleteOrphanedCover cleanup on definitive server rejection (skipped on
 * network_unreachable).
 *
 * NOTE: UpdateProfileInput.avatarUrl / coverUrl are typed `string` (not nullable),
 * so a "Remove" action is not supported by the service and is omitted.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image, ActivityIndicator, Pressable, Alert, StyleSheet } from 'react-native';
import { Camera, ImagePlus } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { renderAvatarImage, renderCoverImage, MAX_ORIGINAL_BYTES } from '../../../src/lib/imageRender';
import {
  getMyProfile, updateMyProfile, uploadAvatar, uploadCover,
  deleteOrphanedAvatar, deleteOrphanedCover,
} from '../../../src/services/profile';
import { resolveProfileSaveOutcome } from '../../../src/services/profileSaveFlow';
import type { OwnProfile } from '../../../src/types/models';
import { PP } from '../../../src/theme/passportTokens';
import { space } from '../../../src/theme/tokens';
import {
  SettingsScreen, SettingsSection, SaveButton, useUnsavedGuard, useSavedThenBack,
  FieldHint, type SaveState,
} from '../../../src/components/settings/SettingsUI';

type PhotoPhase = 'idle' | 'optimizing' | 'uploading';

export default function PhotosScreen() {
  const [loading, setLoading] = useState(true);

  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [photoPhase, setPhotoPhase] = useState<PhotoPhase>('idle');

  const coverOriginalWidthRef = useRef<number>(1920);
  const saveLockRef = useRef(false);
  const savedThenBack = useSavedThenBack(setSaveState);

  const isDirty = avatarUri !== null || coverUri !== null;
  useUnsavedGuard(isDirty);

  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        const p: OwnProfile = res.data;
        setAvatarUrl(p.avatarUrl);
        setCoverUrl(p.coverPhotoUrl);
      }
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
    };
  }, []);

  const pickAvatar = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to update your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      if (asset.fileSize != null && asset.fileSize > MAX_ORIGINAL_BYTES) {
        Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
        return;
      }
      setAvatarUri(asset.uri);
    }
  }, []);

  const pickCover = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to update your cover photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [16, 9],
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      if (asset.fileSize != null && asset.fileSize > MAX_ORIGINAL_BYTES) {
        Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
        return;
      }
      coverOriginalWidthRef.current = asset.width ?? 1920;
      setCoverUri(asset.uri);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (saveLockRef.current || !isDirty) return;
    saveLockRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    try {
      const patch: Parameters<typeof updateMyProfile>[0] = {};
      let uploadedAvatarPath: string | null = null;
      let uploadedCoverPath: string | null = null;

      if (avatarUri) {
        setPhotoPhase('optimizing');
        const rendered = await renderAvatarImage(avatarUri);
        setPhotoPhase('uploading');
        const upRes = await uploadAvatar(rendered.uri, rendered.mimeType);
        setPhotoPhase('idle');
        if (!upRes.ok) {
          setSaveError(upRes.message ?? 'Photo upload failed. Try again.');
          setSaveState('error');
          saveLockRef.current = false;
          return;
        }
        patch.avatarUrl = upRes.data!.url;
        uploadedAvatarPath = upRes.data!.path;
      }

      if (coverUri) {
        setPhotoPhase('optimizing');
        const rendered = await renderCoverImage(coverUri, coverOriginalWidthRef.current);
        setPhotoPhase('uploading');
        const upRes = await uploadCover(rendered.uri, rendered.mimeType);
        setPhotoPhase('idle');
        if (!upRes.ok) {
          setSaveError(upRes.message ?? 'Photo upload failed. Try again.');
          setSaveState('error');
          saveLockRef.current = false;
          return;
        }
        patch.coverUrl = upRes.data!.url;
        uploadedCoverPath = upRes.data!.path;
      }

      if (Object.keys(patch).length === 0) {
        setSaveState('idle');
        saveLockRef.current = false;
        return;
      }

      const res = await updateMyProfile(patch);
      const outcome = resolveProfileSaveOutcome(res);
      if (outcome.kind === 'error') {
        const kind = res.errorKind as string;
        setSaveError(outcome.message);
        setSaveState('error');
        // Clean up newly-uploaded files only when the server definitively rejected
        // the PATCH. Skip on network_unreachable because the PATCH may have succeeded.
        const canCleanup = kind !== 'network_unreachable';
        if (canCleanup) {
          if (uploadedAvatarPath) deleteOrphanedAvatar(uploadedAvatarPath).catch(() => {});
          if (uploadedCoverPath) deleteOrphanedCover(uploadedCoverPath).catch(() => {});
        }
        saveLockRef.current = false;
        return;
      }

      // Success — reflect committed URLs, clear pending picks, reset dirty baseline.
      if (patch.avatarUrl) setAvatarUrl(patch.avatarUrl);
      if (patch.coverUrl) setCoverUrl(patch.coverUrl);
      setAvatarUri(null);
      setCoverUri(null);
      savedThenBack();
    } finally {
      setPhotoPhase('idle');
      saveLockRef.current = false;
    }
  }, [avatarUri, coverUri, isDirty]);

  const avatarSource = avatarUri ?? avatarUrl ?? null;
  const coverSource = coverUri ?? coverUrl ?? null;
  const busy = saveState === 'saving';

  if (loading) {
    return (
      <SettingsScreen title="Photos & Appearance">
        <View style={st.loadingWrap}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen
      title="Photos & Appearance"
      right={<SaveButton state={saveState} onPress={handleSave} disabled={!isDirty} />}
    >
      {saveError ? <FieldHint tone="error">{saveError}</FieldHint> : null}

      <SettingsSection title="Cover Photo">
        <Pressable style={st.coverWrap} onPress={pickCover} disabled={busy}>
          {coverSource ? (
            <Image source={{ uri: coverSource }} style={st.coverImage} />
          ) : (
            <View style={st.coverPlaceholder}>
              <ImagePlus size={28} color={PP.inkMuted} />
              <Text style={st.placeholderText}>Add cover photo</Text>
            </View>
          )}
          <View style={st.editBadge}><Camera size={16} color={PP.paper} /></View>
        </Pressable>
      </SettingsSection>

      <SettingsSection title="Profile Photo">
        <View style={st.avatarSection}>
          <Pressable style={st.avatarWrap} onPress={pickAvatar} disabled={busy}>
            {avatarSource ? (
              <Image source={{ uri: avatarSource }} style={st.avatar} />
            ) : (
              <View style={st.avatarEmpty}>
                <ImagePlus size={24} color={PP.inkMuted} />
              </View>
            )}
            <View style={st.avatarEditBadge}><Camera size={14} color={PP.paper} /></View>
          </Pressable>
          <Text style={st.avatarHint}>Tap to change photo</Text>
        </View>
      </SettingsSection>

      {busy ? (
        <View style={st.overlay}>
          <ActivityIndicator color={PP.ink} size="large" />
          <Text style={st.overlayText}>
            {photoPhase === 'optimizing' ? 'Optimizing…' : photoPhase === 'uploading' ? 'Uploading…' : 'Saving…'}
          </Text>
        </View>
      ) : null}
    </SettingsScreen>
  );
}

const st = StyleSheet.create({
  loadingWrap: { paddingVertical: space.xxxl, alignItems: 'center' },
  coverWrap: {
    height: 160, backgroundColor: PP.paperDeep, justifyContent: 'center', alignItems: 'center',
  },
  coverImage: { width: '100%', height: '100%' },
  coverPlaceholder: { alignItems: 'center', gap: space.xs },
  placeholderText: { fontSize: 13, color: PP.inkMuted, fontWeight: '600' },
  editBadge: {
    position: 'absolute', bottom: space.sm, right: space.sm,
    width: 34, height: 34, borderRadius: 17, backgroundColor: PP.ink,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarSection: { alignItems: 'center', padding: space.lg, gap: space.sm },
  avatarWrap: { width: 96, height: 96 },
  avatar: { width: 96, height: 96, borderRadius: 48, backgroundColor: PP.paperDeep },
  avatarEmpty: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: PP.paperDeep,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarEditBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 30, height: 30, borderRadius: 15, backgroundColor: PP.ink,
    justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: PP.paper,
  },
  avatarHint: { fontSize: 13, color: PP.inkMuted },
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: PP.paper + 'E6', justifyContent: 'center', alignItems: 'center', gap: space.md,
  },
  overlayText: { fontSize: 14, color: PP.ink, fontWeight: '600' },
});
