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

/**
 * A schedule row as the editor holds it.
 *
 * THE RATE IS BASIS POINTS. 1000 == 10 %. `platform_fee_percent` still exists
 * in the table as a rounded legacy mirror and is deliberately NOT part of this
 * shape: an integer percent cannot express 10.5 %, which is why migration 3520
 * moved the rate to basis points, and an editor that round-trips the mirror
 * would quietly put the lossy value back.
 */
interface FeeRule {
  buddy_level: string;
  platform_fee_basis_points: number;
  commission_override_approval: string | null;
  traveler_service_fee_usd: number;
  traveler_service_fee_pct: number;
  description?: string;
}

/**
 * The flat commission (owner decision 2026-10-04). A market override is
 * permitted only when separately approved, which is recorded by a migration —
 * the API refuses any other rate from this screen, and so does a CHECK on the
 * table. Shown here so the operator knows before typing.
 */
const FLAT_COMMISSION_BASIS_POINTS = 1000;

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
    .select('buddy_level, platform_fee_basis_points, commission_override_approval, traveler_service_fee_usd, traveler_service_fee_pct')
    .order('buddy_level', { ascending: true });
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
        platformFeeBasisPoints: r.platform_fee_basis_points,
        travelerServiceFeeUsd: r.traveler_service_fee_usd,
        travelerServiceFeePct: r.traveler_service_fee_pct,
      })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
}

function RuleEditor({ rule, onChange }: { rule: FeeRule; onChange: (r: FeeRule) => void }) {
  // The text the operator is typing, kept separately from the stored rate so a
  // partially-typed "10." is not round-tripped through a number.
  const [percentText, setPercentText] = useState(String(rule.platform_fee_basis_points / 100));
  const offFlat = rule.platform_fee_basis_points !== FLAT_COMMISSION_BASIS_POINTS;
  return (
    <View style={ed.wrap}>
      <Text style={ed.level}>{LEVEL_LABELS[rule.buddy_level] ?? rule.buddy_level}</Text>

      <View style={ed.fieldRow}>
        <View style={ed.field}>
          <Text style={ed.fieldLabel}>Platform fee % (stored as basis points)</Text>
          <View style={ed.inputRow}>
            <TextInput
              style={ed.input}
              keyboardType="decimal-pad"
              value={percentText}
              onChangeText={(v) => {
                setPercentText(v);
                const n = Number(v);
                // An unparseable entry leaves the stored rate alone. Coercing
                // it to 0 — which `Number(v) || 0` did — turns a half-typed
                // keystroke into a 0 % commission the operator never chose.
                if (v.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) return;
                onChange({ ...rule, platform_fee_basis_points: Math.round(n * 100) });
              }}
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
        {rule.platform_fee_basis_points} basis points. Example $100 booking: Buddy earns $
        {((10000 - rule.platform_fee_basis_points) / 100).toFixed(2)} · Platform $
        {(rule.platform_fee_basis_points / 100).toFixed(2)} · Traveler pays $
        {(100 + rule.traveler_service_fee_usd).toFixed(2)}
      </Text>
      {offFlat ? (
        <Text style={ed.example}>
          This is not the flat {FLAT_COMMISSION_BASIS_POINTS / 100}% commission. Saving it will be
          refused: a market override requires separate approval, recorded by a migration.
        </Text>
      ) : null}
      {rule.commission_override_approval ? (
        <Text style={ed.example}>Approved override: {rule.commission_override_approval}</Text>
      ) : null}
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
          <Text style={s.noticeText}>The commission is a flat {FLAT_COMMISSION_BASIS_POINTS / 100}% ({FLAT_COMMISSION_BASIS_POINTS} basis points) across all Buddy levels. Any other rate is refused here: a market override requires separate approval and is recorded by a migration. Changes take effect for new bookings; existing bookings keep the rate already stored on their ledger row.</Text>
        </View>

        {rules.map((rule, idx) => (
          <RuleEditor key={rule.buddy_level} rule={rule} onChange={(updated) => updateRule(idx, updated)} />
        ))}

        {rules.length === 0 && (
          <Text style={s.empty}>No fee rules found. Every fee-dependent screen will refuse until the schedule is seeded — check that the Rent-a-Buddy marketplace migration and 3520 have run.</Text>
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
