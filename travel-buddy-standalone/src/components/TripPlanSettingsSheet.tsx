import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, ActivityIndicator, Alert,
  ScrollView,
} from 'react-native';
import { X, Users, Lock, UserCheck, CheckCircle2 } from 'lucide-react-native';
import {
  fetchTripPlanPermission, updateTripPlanPermission,
  type PlanEditPermission, type TripPlanPermissionResult,
} from '../services/tripPlan';
import { color, space, radius, type as t } from '../theme/tokens';

interface MemberRow {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
}

const PERMISSION_OPTIONS: {
  value: PlanEditPermission;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'all_members',
    label: 'All members',
    description: 'Any accepted trip member can add and edit plan items.',
    icon: <Users size={18} color={color.deep} />,
  },
  {
    value: 'specific_members',
    label: 'Specific members',
    description: 'Only members you choose (plus you) can edit the plan.',
    icon: <UserCheck size={18} color="#7A4DBF" />,
  },
  {
    value: 'owner_only',
    label: 'Owner only',
    description: 'Only you can edit the plan. Members can still view it.',
    icon: <Lock size={18} color={color.signal} />,
  },
];

export function TripPlanSettingsSheet({
  visible,
  tripId,
  onClose,
  onSaved,
}: {
  visible: boolean;
  tripId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [permission, setPermission] = useState<PlanEditPermission>('all_members');
  const [selectedEditors, setSelectedEditors] = useState<string[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result: TripPlanPermissionResult = await fetchTripPlanPermission(tripId);
      setPermission(result.planEditPermission);
      setSelectedEditors(result.planEditors);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  const loadMembers = useCallback(async () => {
    if (members.length > 0) return;
    setMembersLoading(true);
    try {
      const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
      const { supabase } = await import('../lib/supabase');
      const { data: refreshed } = await supabase.auth.refreshSession();
      const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
      const token = session?.access_token;
      if (!token) return;

      const res = await fetch(`${apiBase}/api/trips/${tripId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = await res.json();
      setMembers(json.members ?? []);
    } catch {
      // ignore
    } finally {
      setMembersLoading(false);
    }
  }, [tripId, members.length]);

  useEffect(() => {
    if (visible) {
      load();
    }
  }, [visible, load]);

  useEffect(() => {
    if (visible && permission === 'specific_members') {
      loadMembers();
    }
  }, [visible, permission, loadMembers]);

  const toggleEditor = (userId: string) => {
    setSelectedEditors((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const editors = permission === 'specific_members' ? selectedEditors : undefined;
      await updateTripPlanPermission(tripId, permission, editors);
      onSaved?.();
      onClose();
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.handle} />

        <View style={s.header}>
          <Text style={s.title}>Plan editing</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>

        <Text style={s.subtitle}>Who can add and edit items in this trip's plan?</Text>

        {loading ? (
          <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} />
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.body}>
            {PERMISSION_OPTIONS.map((opt) => {
              const active = permission === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[s.option, active && s.optionActive]}
                  onPress={() => setPermission(opt.value)}
                >
                  <View style={s.optionIcon}>{opt.icon}</View>
                  <View style={s.optionText}>
                    <Text style={[s.optionLabel, active && s.optionLabelActive]}>{opt.label}</Text>
                    <Text style={s.optionDesc}>{opt.description}</Text>
                  </View>
                  {active && <CheckCircle2 size={18} color={color.deep} />}
                </Pressable>
              );
            })}

            {permission === 'specific_members' && (
              <View style={s.memberSection}>
                <Text style={s.memberLabel}>Choose who can edit</Text>
                {membersLoading ? (
                  <ActivityIndicator color={color.signal} style={{ marginVertical: space.md }} />
                ) : members.length === 0 ? (
                  <Text style={s.noMembers}>No other members in this trip yet.</Text>
                ) : (
                  members.map((m) => {
                    const selected = selectedEditors.includes(m.id);
                    return (
                      <Pressable
                        key={m.id}
                        style={[s.memberRow, selected && s.memberRowActive]}
                        onPress={() => toggleEditor(m.id)}
                      >
                        <View style={s.memberAvatar}>
                          <Text style={s.memberAvatarText}>{m.name.charAt(0).toUpperCase()}</Text>
                        </View>
                        <View style={s.memberInfo}>
                          <Text style={s.memberName}>{m.name}</Text>
                          <Text style={s.memberHandle}>@{m.handle}</Text>
                        </View>
                        {selected && <CheckCircle2 size={16} color={color.deep} />}
                      </Pressable>
                    );
                  })
                )}
              </View>
            )}

            <View style={s.actions}>
              <Pressable style={s.cancelBtn} onPress={onClose} disabled={saving}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={[s.saveBtn, saving && s.saveBtnDisabled]} onPress={handleSave} disabled={saving}>
                {saving
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={s.saveBtnText}>Save</Text>
                }
              </Pressable>
            </View>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: space.lg, paddingBottom: 36, maxHeight: '80%',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginTop: 10, marginBottom: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  title: { ...t.title, color: color.ink, fontSize: 18 },
  subtitle: { ...t.body, color: color.mute, marginBottom: space.lg },
  body: { gap: space.sm, paddingBottom: 4 },

  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.md, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  optionActive: { borderColor: color.deep, backgroundColor: '#EEF4FF' },
  optionIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#F0F4FF', alignItems: 'center', justifyContent: 'center' },
  optionText: { flex: 1 },
  optionLabel: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  optionLabelActive: { color: color.deep },
  optionDesc: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 18 },

  memberSection: { marginTop: space.sm, gap: space.sm },
  memberLabel: { ...t.small, color: color.mute, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 11 },
  noMembers: { ...t.body, color: color.mute, textAlign: 'center', paddingVertical: space.md },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  memberRowActive: { borderColor: color.deep, backgroundColor: '#EEF4FF' },
  memberAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  memberAvatarText: { ...t.small, color: '#fff', fontWeight: '700' },
  memberInfo: { flex: 1 },
  memberName: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  memberHandle: { ...t.small, color: color.mute },

  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  cancelBtn: { flex: 1, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, alignItems: 'center' },
  cancelBtnText: { ...t.bodyStrong, color: color.mute },
  saveBtn: { flex: 1, padding: space.md, borderRadius: radius.md, backgroundColor: color.deep, alignItems: 'center' },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { ...t.bodyStrong, color: '#fff' },
});
