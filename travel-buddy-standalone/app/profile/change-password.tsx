import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView,
  ActivityIndicator, Alert, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { changePassword } from '../../src/services/auth';
import { color, space, radius } from '../../src/theme/tokens';

export default function ChangePassword() {
  const insets = useSafeAreaInsets();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  const saveLockRef = useRef(false);

  const isValid =
    newPassword.length >= 8 &&
    confirmPassword.length >= 8 &&
    newPassword === confirmPassword;

  async function handleSave() {
    if (!isValid || saveLockRef.current) return;
    saveLockRef.current = true;
    setSaving(true);
    try {
      if (newPassword !== confirmPassword) {
        Alert.alert('Passwords do not match', 'Please make sure both passwords are identical.');
        return;
      }
      const result = await changePassword(newPassword);
      if (result.error) {
        Alert.alert('Could not update password', result.error);
        return;
      }
      Alert.alert('Password updated', 'Your password has been changed successfully.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } finally {
      saveLockRef.current = false;
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: color.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}
          onPress={() => router.back()}
          hitSlop={12}
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Change Password</Text>
        <Pressable
          style={[styles.saveBtn, (!isValid || saving) && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!isValid || saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color={color.onInk} />
          ) : (
            <Text style={[styles.saveText, (!isValid || saving) && styles.saveTextDisabled]}>Save</Text>
          )}
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.hint}>
          Choose a new password with at least 8 characters.
        </Text>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>New password</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="At least 8 characters"
              placeholderTextColor={color.faint}
              secureTextEntry={!showNew}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
            <Pressable onPress={() => setShowNew((v) => !v)} hitSlop={8} style={styles.eyeBtn}>
              {showNew ? (
                <EyeOff size={18} color={color.mute} />
              ) : (
                <Eye size={18} color={color.mute} />
              )}
            </Pressable>
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Confirm new password</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Repeat your new password"
              placeholderTextColor={color.faint}
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />
            <Pressable onPress={() => setShowConfirm((v) => !v)} hitSlop={8} style={styles.eyeBtn}>
              {showConfirm ? (
                <EyeOff size={18} color={color.mute} />
              ) : (
                <Eye size={18} color={color.mute} />
              )}
            </Pressable>
          </View>
          {confirmPassword.length > 0 && newPassword !== confirmPassword && (
            <Text style={styles.mismatch}>Passwords do not match</Text>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  back: {
    padding: space.xs,
    marginRight: space.sm,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: color.ink,
  },
  saveBtn: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    minWidth: 56,
    alignItems: 'center',
  },
  saveBtnDisabled: {
    backgroundColor: color.faint,
  },
  saveText: {
    fontSize: 14,
    fontWeight: '600',
    color: color.onInk,
  },
  saveTextDisabled: {
    color: color.mute,
  },
  body: {
    padding: space.lg,
    gap: space.xl,
  },
  hint: {
    fontSize: 13,
    color: color.mute,
    lineHeight: 20,
  },
  fieldGroup: {
    gap: space.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: color.ink,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    backgroundColor: color.paperRaised,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: color.ink,
    paddingVertical: space.sm,
  },
  eyeBtn: {
    padding: space.xs,
  },
  mismatch: {
    fontSize: 12,
    color: color.signal,
  },
});
