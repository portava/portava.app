import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  submitAppeal,
  getMyAppeals,
  type Appeal,
  type AppealTargetType,
  type AppealState,
} from '../src/services/appeals';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { PlainBottomFiller } from '../src/hooks/useBottomInset';

// ── State badge ───────────────────────────────────────────────────────────────

const STATE_CONFIG: Record<AppealState, { label: string; color: string; bg: string }> = {
  submitted:    { label: 'Submitted',    color: '#92400E', bg: '#FEF3C7' },
  under_review: { label: 'Under Review', color: '#1E40AF', bg: '#DBEAFE' },
  approved:     { label: 'Approved',     color: '#065F46', bg: '#D1FAE5' },
  denied:       { label: 'Denied',       color: '#991B1B', bg: '#FEE2E2' },
};

function StateBadge({ state }: { state: AppealState }) {
  const cfg = STATE_CONFIG[state] ?? STATE_CONFIG.submitted;
  return (
    <View style={[s.badge, { backgroundColor: cfg.bg }]}>
      <Text style={[s.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

// ── Appeal card ───────────────────────────────────────────────────────────────

function AppealCard({ appeal }: { appeal: Appeal }) {
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <Text style={s.cardType}>{appeal.targetType.replace(/_/g, ' ')}</Text>
        <StateBadge state={appeal.state} />
      </View>
      <Text style={s.cardReason} numberOfLines={3}>{appeal.reason}</Text>
      {appeal.resolutionNote && (
        <View style={s.resolution}>
          <Text style={s.resolutionLabel}>Moderator note</Text>
          <Text style={s.resolutionText}>{appeal.resolutionNote}</Text>
        </View>
      )}
      <Text style={s.cardDate}>{new Date(appeal.createdAt).toLocaleDateString()}</Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function AppealsScreen() {
  const params = useLocalSearchParams<{
    targetType?: string;
    targetId?: string;
  }>();

  const [appeals, setAppeals]         = useState<Appeal[]>([]);
  const [loading, setLoading]         = useState(true);
  const [submitting, setSubmitting]   = useState(false);
  const [showForm, setShowForm]       = useState(!!params.targetType);

  const [reason, setReason]           = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');

  const navBarScrollHandler = useNavBarScrollHandler();

  const targetType  = (params.targetType as AppealTargetType | undefined) ?? 'account_warning';
  const targetId    = params.targetId ?? '';

  const load = useCallback(async () => {
    try {
      const res = await getMyAppeals();
      setAppeals(res.appeals);
    } catch {
      // silent — show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (reason.trim().length < 10) {
      Alert.alert('Too short', 'Please explain your appeal in at least 10 characters.');
      return;
    }
    if (!targetId) {
      Alert.alert('Error', 'No target specified. Please go back and try again.');
      return;
    }

    setSubmitting(true);
    try {
      await submitAppeal({
        targetType,
        targetId,
        reason: reason.trim(),
        evidenceUrl: evidenceUrl.trim() || undefined,
      });
      setReason('');
      setEvidenceUrl('');
      setShowForm(false);
      Alert.alert('Appeal submitted', 'We will review your appeal and notify you of the outcome.');
      await load();
    } catch (e: any) {
      const code = (e as any).code;
      if (code === 'appeal_already_active') {
        Alert.alert('Already appealed', 'You already have an active appeal for this. Check below for its status.');
        setShowForm(false);
        await load();
      } else {
        Alert.alert('Error', e?.message ?? 'Could not submit appeal. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" onScroll={navBarScrollHandler} scrollEventThrottle={16}>

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Appeals</Text>
        <Text style={s.subtitle}>
          Appeal a moderation decision — we review every appeal carefully.
        </Text>
      </View>

      {/* New appeal form */}
      {showForm ? (
        <View style={s.form}>
          <Text style={s.formTitle}>
            Submit Appeal
            {targetType ? ` · ${targetType.replace(/_/g, ' ')}` : ''}
          </Text>

          <Text style={s.fieldLabel}>Explanation *</Text>
          <TextInput
            style={s.textArea}
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={6}
            maxLength={3000}
            placeholder="Explain why you believe this decision was incorrect. Include any relevant context or details."
            placeholderTextColor="#9CA3AF"
            textAlignVertical="top"
          />
          <Text style={s.charCount}>{reason.length}/3000</Text>

          <Text style={[s.fieldLabel, { marginTop: 12 }]}>Evidence URL (optional)</Text>
          <TextInput
            style={s.input}
            value={evidenceUrl}
            onChangeText={setEvidenceUrl}
            placeholder="https://…"
            placeholderTextColor="#9CA3AF"
            autoCapitalize="none"
            keyboardType="url"
          />

          <TouchableOpacity
            style={[s.submitBtn, (submitting || reason.trim().length < 10) && s.submitBtnDisabled]}
            onPress={submit}
            disabled={submitting || reason.trim().length < 10}
          >
            {submitting ? (
              <ActivityIndicator color="#FAF9F6" />
            ) : (
              <Text style={s.submitBtnText}>Submit Appeal</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={s.cancelFormBtn} onPress={() => setShowForm(false)}>
            <Text style={s.cancelFormText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={s.newAppealBtn} onPress={() => setShowForm(true)}>
          <Text style={s.newAppealBtnText}>+ New Appeal</Text>
        </TouchableOpacity>
      )}

      {/* Appeal history */}
      <View style={s.historySection}>
        <Text style={s.sectionTitle}>Your Appeals</Text>

        {loading ? (
          <ActivityIndicator color="#11110F" style={{ marginTop: 24 }} />
        ) : appeals.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={s.emptyIcon}>📋</Text>
            <Text style={s.emptyTitle}>No appeals yet</Text>
            <Text style={s.emptyBody}>
              If you believe a moderation action was made in error, you can submit an appeal above.
            </Text>
          </View>
        ) : (
          appeals.map((a) => <AppealCard key={a.id} appeal={a} />)
        )}
      </View>

      <PlainBottomFiller />

    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF9F6' },
  content:   { padding: 20, paddingBottom: 60 },

  header:   { marginBottom: 20 },
  backBtn:  { marginBottom: 12 },
  backText: { fontSize: 16, color: '#6B7280' },
  title:    { fontSize: 24, fontWeight: '700', color: '#11110F', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#6B7280', lineHeight: 20 },

  form:       {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  formTitle:  { fontSize: 16, fontWeight: '700', color: '#11110F', marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6 },
  textArea:   {
    borderWidth: 1,
    borderColor: '#E8E5DE',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#11110F',
    minHeight: 140,
    backgroundColor: '#FAF9F6',
  },
  input:      {
    borderWidth: 1,
    borderColor: '#E8E5DE',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#11110F',
    backgroundColor: '#FAF9F6',
  },
  charCount:  { fontSize: 11, color: '#9CA3AF', textAlign: 'right', marginTop: 4 },

  submitBtn:          {
    backgroundColor: '#11110F',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  submitBtnDisabled:  { opacity: 0.4 },
  submitBtnText:      { color: '#FAF9F6', fontSize: 15, fontWeight: '700' },
  cancelFormBtn:      { alignItems: 'center', paddingVertical: 10, marginTop: 4 },
  cancelFormText:     { fontSize: 14, color: '#6B7280' },

  newAppealBtn:     {
    borderWidth: 1,
    borderColor: '#11110F',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 20,
  },
  newAppealBtnText: { fontSize: 14, fontWeight: '600', color: '#11110F' },

  historySection: { marginTop: 8 },
  sectionTitle:   { fontSize: 16, fontWeight: '700', color: '#11110F', marginBottom: 12 },

  card:       {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  cardType:   { fontSize: 13, fontWeight: '600', color: '#11110F', textTransform: 'capitalize' },
  cardReason: { fontSize: 13, color: '#374151', lineHeight: 18, marginBottom: 8 },
  cardDate:   { fontSize: 11, color: '#9CA3AF', marginTop: 4 },

  resolution:      {
    backgroundColor: '#F0FDF4',
    borderRadius: 6,
    padding: 10,
    marginBottom: 6,
  },
  resolutionLabel: { fontSize: 11, fontWeight: '600', color: '#065F46', marginBottom: 3 },
  resolutionText:  { fontSize: 13, color: '#065F46', lineHeight: 17 },

  badge:     {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },

  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyIcon:  { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#11110F', marginBottom: 6 },
  emptyBody:  { fontSize: 13, color: '#6B7280', textAlign: 'center', lineHeight: 18, maxWidth: 280 },
});
