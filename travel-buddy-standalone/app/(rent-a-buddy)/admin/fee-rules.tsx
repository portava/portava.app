import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Save, DollarSign, Percent } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { TravelButton, TravelLoadingState, TravelErrorState } from '../../../src/components/primitives';
import { supabase } from '../../../src/lib/supabase';

const apiBase = () => (process.env.EXPO_PUBLIC_API_BASE_URL ?? '');

interface FeeRule {
  buddy_level: string;
  platform_fee_percent: number;
  traveler_service_fee_usd: number;
  traveler_service_fee_pct: number;
  description?: string;
}

const LEVEL_LABELS: Record<string, string> = {
  new: 'New Buddy',
  rising: 'Rising',
  pro: 'Pro',
  elite: 'Elite',
  city_ambassador: 'City Ambassador',
};

async function authToken(): Promise<string | undefined> {
  const { data: s } = await supabase.auth.getSession();
  return s.session?.access_token;
}

async function loadFeeRules(): Promise<FeeRule[]> {
  const { data, error } = await supabase
    .from('rent_buddy_fee_rules')
    .select('*')
    .order('platform_fee_percent', { ascending: false });
  if (error) throw error;
  return (data ?? []) as FeeRule[];
}

async function saveFeeRules(rules: FeeRule[]) {
  const token = await authToken();
  const res = await fetch(`${apiBase()}/api/rent-a-buddy/admin/fee-rules`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      updates: rules.map((r) => ({
        buddyLevel: r.buddy_level,
        platformFeePercent: r.platform_fee_percent,
        travelerServiceFeeUsd: r.traveler_service_fee_usd,
        travelerServiceFeePct: r.traveler_service_fee_pct,
      })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
}

function RuleEditor({ rule, onChange }: { rule: FeeRule; onChange: (r: FeeRule) => void }) {
  return (
    <View style={ed.wrap}>
      <Text style={ed.level}>{LEVEL_LABELS[rule.buddy_level] ?? rule.buddy_level}</Text>

      <View style={ed.fieldRow}>
        <View style={ed.field}>
          <Text style={ed.fieldLabel}>Platform fee %</Text>
          <View style={ed.inputRow}>
            <TextInput
              style={ed.input}
              keyboardType="decimal-pad"
              value={String(rule.platform_fee_percent)}
              onChangeText={(v) => onChange({ ...rule, platform_fee_percent: Number(v) || 0 })}
            />
            <Percent size={14} color={color.mute} />
          </View>
        </View>

        <View style={ed.field}>
          <Text style={ed.fieldLabel}>Traveler fee $</Text>
          <View style={ed.inputRow}>
            <DollarSign size={14} color={color.mute} />
            <TextInput
              style={ed.input}
              keyboardType="decimal-pad"
              value={String(rule.traveler_service_fee_usd)}
              onChangeText={(v) => onChange({ ...rule, traveler_service_fee_usd: Number(v) || 0 })}
            />
          </View>
        </View>
      </View>

      <Text style={ed.example}>
        Example $100 booking: Buddy earns ${(100 * (1 - rule.platform_fee_percent / 100)).toFixed(2)} · Platform ${(100 * rule.platform_fee_percent / 100).toFixed(2)} · Traveler pays ${(100 + rule.traveler_service_fee_usd).toFixed(2)}
      </Text>
    </View>
  );
}

import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

export default function FeeRulesEditor() {
  useRequireAdmin();
  const insets = useSafeAreaInsets();
  const [rules, setRules] = useState<FeeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadFeeRules()
      .then(setRules)
      .catch((err) => setError(err?.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const updateRule = useCallback((idx: number, updated: FeeRule) => {
    setRules((prev) => prev.map((r, i) => (i === idx ? updated : r)));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await saveFeeRules(rules);
      Alert.alert('Saved', 'Fee rules updated successfully.');
    } catch (err: any) {
      Alert.alert('Error', bookingErrorCopy(err?.message));
    } finally {
      setSaving(false);
    }
  }, [rules]);

  if (loading) return <TravelLoadingState label="Loading fee rules…" />;
  if (error) return <TravelErrorState title="Failed to load" sub={error} onRetry={() => { setLoading(true); setError(null); loadFeeRules().then(setRules).catch((e) => setError(e.message)).finally(() => setLoading(false)); }} />;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Fee Rules</Text>
        {saving && <ActivityIndicator size="small" color={color.deep} />}
      </View>

      <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + space.xxxl }]} showsVerticalScrollIndicator={false}>
        <View style={s.notice}>
          <Text style={s.noticeText}>Changes take effect immediately for new bookings. Existing bookings use the fee percent already stored in the ledger.</Text>
        </View>

        {rules.map((rule, idx) => (
          <RuleEditor key={rule.buddy_level} rule={rule} onChange={(updated) => updateRule(idx, updated)} />
        ))}

        {rules.length === 0 && (
          <Text style={s.empty}>No fee rules found. Check that the 0047 migration has run.</Text>
        )}

        <Pressable
          style={[ed2.saveBtn, (saving || rules.length === 0) && ed2.saveBtnDisabled]}
          onPress={save}
          disabled={saving || rules.length === 0}
        >
          <Save size={16} color="#fff" />
          <Text style={ed2.saveBtnLabel}>{saving ? 'Saving…' : 'Save Fee Rules'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink, flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  notice: { backgroundColor: `${color.warn}12`, borderRadius: radius.md, padding: space.md },
  noticeText: { ...t.small, color: color.warn },
  empty: { ...t.body, color: color.mute, textAlign: 'center', marginTop: space.xxxl },
});

const ed2 = StyleSheet.create({
  saveBtn: { marginTop: space.lg, backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.lg, flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: space.sm },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnLabel: { ...t.body, color: '#fff', fontWeight: '700' as const },
});

const ed = StyleSheet.create({
  wrap: { backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg },
  level: { ...t.bodyStrong, color: color.ink, marginBottom: space.md },
  fieldRow: { flexDirection: 'row', gap: space.md, marginBottom: space.sm },
  field: { flex: 1 },
  fieldLabel: { ...t.small, color: color.mute, marginBottom: space.sm },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: color.haze, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, gap: space.sm },
  input: { ...t.body, color: color.ink, flex: 1, paddingVertical: space.md },
  example: { ...t.small, color: color.mute, fontStyle: 'italic', marginTop: space.sm },
});
