/**
 * Photos & Appearance — avatar + cover with immediate save flow.
 *
 * Picking is delegated to useMediaComposer (profileAvatar / profileCover
 * policies) so that the denied→Settings path, iOS limited-library prompt, and
 * allowsEditing / aspect-ratio crop are handled by the shared kit.
 *
 * Sheet visibility is managed locally here because the trigger is the whole
 * avatar / cover tap area, not a MediaPickerButton. Two useEffects sync the
 * picked item's URI into local state so the existing handleSave flow
 * (renderAvatarImage → upload → updateMyProfile) is unchanged.
 *
 * NOTE: UpdateProfileInput.avatarUrl / coverUrl are typed `string` (not nullable),
 * so a "Remove" action is not supported by the service and is omitted.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image, ActivityIndicator, Pressable, Alert, StyleSheet } from 'react-native';
import { Camera, ImagePlus } from 'lucide-react-native';
import { renderAvatarImage, renderCoverImage, MAX_ORIGINAL_BYTES, ImageStripFailedError } from '../../../src/lib/imageRender';
import {
  getMyProfile, updateMyProfile, uploadAvatar, uploadCover,
  deleteOrphanedAvatar, deleteOrphanedCover,
} from '../../../src/services/profile';
import { resolveProfileSaveOutcome } from '../../../src/services/profileSaveFlow';
import type { OwnProfile } from '../../../src/types/models';
import { PP } from '../../../src/theme/passportTokens';
import { space, avatar } from '../../../src/theme/tokens';
import {
  SettingsScreen, SettingsSection, SaveButton, useUnsavedGuard, useSavedThenBack,
  FieldHint, type SaveState,
} from '../../../src/components/settings/SettingsUI';
import { useMediaComposer } from '../../../src/hooks/useMediaComposer.ts';
import { MediaSourceSheet } from '../../../src/components/ui/MediaSourceSheet.tsx';

type PhotoPhase = 'idle' | 'optimizing' | 'uploading';

export default function PhotosScreen() {
  const [loading, setLoading] = useState(true);

  const [avatarSheetVisible, setAvatarSheetVisible] = useState(false);
  const [coverSheetVisible, setCoverSheetVisible] = useState(false);

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

  // ── Shared-kit composer instances ──────────────────────────────────────────
  // profileAvatar policy: allowsEditing=true, aspect=[1,1], images only
  // profileCover  policy: allowsEditing=true, aspect=[16,9], images only
  const avatarComposer = useMediaComposer('profileAvatar');
  const coverComposer  = useMediaComposer('profileCover');

  // Sync picked avatar URI into local state for the save flow
  useEffect(() => {
    const item = avatarComposer.primaryItem;
    if (!item) return;
    if (item.fileSize != null && item.fileSize > MAX_ORIGINAL_BYTES) {
      Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
      avatarComposer.clearAll();
      return;
    }
    setAvatarUri(item.uri);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarComposer.primaryItem?.id]);

  // Sync picked cover URI into local state for the save flow
  useEffect(() => {
    const item = coverComposer.primaryItem;
    if (!item) return;
    if (item.fileSize != null && item.fileSize > MAX_ORIGINAL_BYTES) {
      Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
      coverComposer.clearAll();
      return;
    }
    coverOriginalWidthRef.current = item.width ?? 1920;
    setCoverUri(item.uri);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverComposer.primaryItem?.id]);

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
        let rendered;
        try {
          rendered = await renderAvatarImage(avatarUri);
        } catch (err) {
          setSaveError(err instanceof ImageStripFailedError ? err.message : 'Photo upload failed. Try again.');
          setSaveState('error');
          saveLockRef.current = false;
          return;
        }
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
        patch.avatarImageWidth  = upRes.data!.width  ?? undefined;
        patch.avatarImageHeight = upRes.data!.height ?? undefined;
        uploadedAvatarPath = upRes.data!.path;
      }

      if (coverUri) {
        setPhotoPhase('optimizing');
        let rendered;
        try {
          rendered = await renderCoverImage(coverUri, coverOriginalWidthRef.current);
        } catch (err) {
          setSaveError(err instanceof ImageStripFailedError ? err.message : 'Photo upload failed. Try again.');
          setSaveState('error');
          saveLockRef.current = false;
          return;
        }
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
        patch.coverImageWidth  = upRes.data!.width  ?? undefined;
        patch.coverImageHeight = upRes.data!.height ?? undefined;
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
        const canCleanup = kind !== 'network_unreachable';
        if (canCleanup) {
          if (uploadedAvatarPath) deleteOrphanedAvatar(uploadedAvatarPath).catch(() => {});
          if (uploadedCoverPath) deleteOrphanedCover(uploadedCoverPath).catch(() => {});
        }
        saveLockRef.current = false;
        return;
      }

      if (patch.avatarUrl) setAvatarUrl(patch.avatarUrl);
      if (patch.coverUrl) setCoverUrl(patch.coverUrl);
      setAvatarUri(null);
      setCoverUri(null);
      // Reset composer state after successful save
      avatarComposer.clearAll();
      coverComposer.clearAll();
      savedThenBack();
    } finally {
      setPhotoPhase('idle');
      saveLockRef.current = false;
    }
  }, [avatarUri, coverUri, isDirty]);

  const avatarSource = avatarUri ?? avatarUrl ?? null;
  const coverSource  = coverUri  ?? coverUrl  ?? null;
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
        <Pressable style={st.coverWrap} onPress={() => setCoverSheetVisible(true)} disabled={busy}>
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
          <Pressable style={st.avatarWrap} onPress={() => setAvatarSheetVisible(true)} disabled={busy}>
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

      {/* Pickers — rendered unconditionally as Modals so the sheet always
          finds a mounted component. Sheet visibility is managed by local
          state because the trigger is the whole avatar / cover tap area,
          not a MediaPickerButton. */}
      <MediaSourceSheet
        visible={avatarSheetVisible}
        onClose={() => setAvatarSheetVisible(false)}
        onResult={(asset) => { setAvatarSheetVisible(false); avatarComposer.onPickResult(asset); }}
        allowsVideo={false}
        allowsEditing={avatarComposer.policy.allowsEditing}
        aspect={avatarComposer.policy.editAspect}
        title="Profile photo"
      />
      <MediaSourceSheet
        visible={coverSheetVisible}
        onClose={() => setCoverSheetVisible(false)}
        onResult={(asset) => { setCoverSheetVisible(false); coverComposer.onPickResult(asset); }}
        allowsVideo={false}
        allowsEditing={coverComposer.policy.allowsEditing}
        aspect={coverComposer.policy.editAspect}
        title="Cover photo"
      />
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
    width: avatar.s34, height: avatar.s34, borderRadius: avatar.s34 / 2, backgroundColor: PP.ink,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarSection: { alignItems: 'center', padding: space.lg, gap: space.sm },
  avatarWrap: { width: 96, height: 96 },
  avatar: { width: avatar.s96, height: avatar.s96, borderRadius: avatar.s96 / 2, backgroundColor: PP.paperDeep },
  avatarEmpty: {
    width: avatar.s96, height: avatar.s96, borderRadius: avatar.s96 / 2, backgroundColor: PP.paperDeep,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarEditBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: avatar.s30, height: avatar.s30, borderRadius: avatar.s30 / 2, backgroundColor: PP.ink,
    justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: PP.paper,
  },
  avatarHint: { fontSize: 13, color: PP.inkMuted },
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: PP.paper + 'E6', justifyContent: 'center', alignItems: 'center', gap: space.md,
  },
  overlayText: { fontSize: 14, color: PP.ink, fontWeight: '600' },
});
