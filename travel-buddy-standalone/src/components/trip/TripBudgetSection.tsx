/**
 * TripBudgetSection — Trip detail budget block.
 *
 * Shows:
 *  - Manual budget row (owner/co-host only, editable by owner)
 *  - AI cost estimate bands when fetchCostEstimate returns available: true
 *  - Unavailable reason when available: false
 *  - "What if…" sandbox sheet for scenario planning
 *
 * Returns null entirely when fetchCostEstimate returns null (flag off).
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, Pressable, TextInput, Modal, ScrollView,
  ActivityIndicator, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { DollarSign, Sliders, X, ChevronDown, ChevronUp } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import {
  fetchCostEstimate,
  fetchManualBudget,
  updateManualBudget,
  runBudgetSandbox,
  type CostEstimate,
  type SandboxResultAvailable,
  type ManualBudget,
} from '../../services/tripIntel.ts';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TripBudgetSectionProps {
  tripId: string;
  /** True when the current user is the trip owner or a co-host. */
  isOwnerOrCohost: boolean;
  /** True when the current user is the trip owner (can write budget). */
  isOwner: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBand(low: number, high: number, currency: string): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  return `${fmt(low)} – ${fmt(high)}`;
}

function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

const PROTECTED_CATEGORY_OPTIONS = [
  'accommodation', 'food', 'transport', 'activities', 'shopping', 'misc',
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfidenceChip({ confidence }: { confidence: string }) {
  const bg =
    confidence === 'high'   ? '#E8F5E9' :
    confidence === 'medium' ? '#FFF8E1' :
                              '#FBE9E7';
  const fg =
    confidence === 'high'   ? '#2E7D32' :
    confidence === 'medium' ? '#F57F17' :
                              '#BF360C';
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]}>{confidence} confidence</Text>
    </View>
  );
}

function BandRow({ label, band, currency }: { label: string; band: { low: number; mid: number; high: number }; currency: string }) {
  return (
    <View style={styles.bandRow}>
      <Text style={styles.bandLabel}>{label}</Text>
      <Text style={styles.bandValue}>{formatBand(band.low, band.high, currency)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sandbox sheet
// ---------------------------------------------------------------------------

interface SandboxSheetProps {
  tripId: string;
  visible: boolean;
  onClose: () => void;
}

function WhatIfSandboxSheet({ tripId, visible, onClose }: SandboxSheetProps) {
  const [extraDays, setExtraDays] = useState('');
  const [dailyOverride, setDailyOverride] = useState('');
  const [budgetDelta, setBudgetDelta] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SandboxResultAvailable | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setExtraDays('');
    setDailyOverride('');
    setBudgetDelta('');
    setSelectedCategories([]);
    setResult(null);
    setError(null);
    setLoading(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function toggleCategory(cat: string) {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  }

  async function handleRun() {
    setLoading(true);
    setError(null);
    setResult(null);
    const params: Parameters<typeof runBudgetSandbox>[1] = {};
    const ed = parseFloat(extraDays);
    const do_ = parseFloat(dailyOverride);
    const bd = parseFloat(budgetDelta);
    if (!isNaN(ed) && ed !== 0) params.extraDays = ed;
    if (!isNaN(do_) && do_ > 0) params.dailySpendOverride = do_;
    if (!isNaN(bd) && bd !== 0) params.budgetDelta = bd;
    if (selectedCategories.length > 0) params.protectedCategories = selectedCategories;

    const res = await runBudgetSandbox(tripId, params);
    setLoading(false);
    if (!res || !res.available) {
      setError('Could not run scenario. Try again.');
    } else {
      setResult(res as SandboxResultAvailable);
    }
  }

  const currency = result?.dailySpend ? 'USD' : 'USD'; // currency lives on estimate; sandbox doesn't carry it

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.sandboxOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sandboxSheet}>
          {/* Header */}
          <View style={styles.sandboxHeader}>
            <Text style={styles.sandboxTitle}>What if…</Text>
            <Pressable onPress={handleClose} hitSlop={8} accessibilityLabel="Close">
              <X size={20} color={color.ink} />
            </Pressable>
          </View>
          <Text style={styles.sandboxSub}>Adjust trip parameters and see how the cost estimate changes.</Text>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Inputs */}
            <View style={styles.sandboxInputGroup}>
              <Text style={styles.inputLabel}>Extra days</Text>
              <TextInput
                style={styles.sandboxInput}
                value={extraDays}
                onChangeText={setExtraDays}
                keyboardType="numeric"
                placeholder="e.g. 2"
                placeholderTextColor={color.faint}
                accessibilityLabel="Extra days"
              />
            </View>

            <View style={styles.sandboxInputGroup}>
              <Text style={styles.inputLabel}>Daily spend override (amount)</Text>
              <TextInput
                style={styles.sandboxInput}
                value={dailyOverride}
                onChangeText={setDailyOverride}
                keyboardType="numeric"
                placeholder="e.g. 150"
                placeholderTextColor={color.faint}
                accessibilityLabel="Daily spend override"
              />
            </View>

            <View style={styles.sandboxInputGroup}>
              <Text style={styles.inputLabel}>Budget delta (positive = more, negative = less)</Text>
              <TextInput
                style={styles.sandboxInput}
                value={budgetDelta}
                onChangeText={setBudgetDelta}
                keyboardType="numeric"
                placeholder="e.g. -200"
                placeholderTextColor={color.faint}
                accessibilityLabel="Budget delta"
              />
            </View>

            <View style={styles.sandboxInputGroup}>
              <Text style={styles.inputLabel}>Protected categories (won't be scaled)</Text>
              <View style={styles.categoryRow}>
                {PROTECTED_CATEGORY_OPTIONS.map((cat) => {
                  const active = selectedCategories.includes(cat);
                  return (
                    <Pressable
                      key={cat}
                      style={[styles.catChip, active && styles.catChipActive]}
                      onPress={() => toggleCategory(cat)}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.catChipText, active && styles.catChipTextActive]}>
                        {cat}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Result */}
            {result && (
              <View style={styles.sandboxResult}>
                <Text style={styles.sandboxResultTitle}>Scenario result</Text>
                {result.dailySpend && (
                  <BandRow
                    label="Per day"
                    band={result.dailySpend}
                    currency={currency}
                  />
                )}
                {result.total && (
                  <BandRow
                    label="Total trip"
                    band={result.total}
                    currency={currency}
                  />
                )}
                {result.days != null && (
                  <Text style={styles.sandboxResultNote}>
                    Based on {String(result.days)} day{result.days === 1 ? '' : 's'}
                  </Text>
                )}
                {result.notes && result.notes.length > 0 && (
                  <Text style={styles.sandboxResultNote}>{result.notes[0]}</Text>
                )}
              </View>
            )}

            {error && (
              <View style={styles.sandboxError}>
                <Text style={styles.sandboxErrorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <Pressable
            style={[styles.sandboxRunBtn, loading && { opacity: 0.6 }]}
            onPress={handleRun}
            disabled={loading}
            accessibilityRole="button"
          >
            {loading
              ? <ActivityIndicator color={color.onInk} size="small" />
              : <Text style={styles.sandboxRunBtnText}>Run scenario</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Breakdown edit sheet
// ---------------------------------------------------------------------------

const BREAKDOWN_CATEGORIES = [
  'accommodation', 'food', 'transport', 'activities', 'shopping', 'misc',
] as const;

interface BreakdownEditSheetProps {
  visible: boolean;
  initialBreakdown: Record<string, number> | null;
  currency: string;
  onClose: () => void;
  onSave: (breakdown: Record<string, number>) => Promise<void>;
}

function BreakdownEditSheet({
  visible, initialBreakdown, currency, onClose, onSave,
}: BreakdownEditSheetProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const cat of BREAKDOWN_CATEGORIES) {
      init[cat] = initialBreakdown?.[cat] != null ? String(initialBreakdown[cat]) : '';
    }
    return init;
  });
  const [saving, setSaving] = useState(false);

  // Re-initialise when sheet is opened with new data.
  useEffect(() => {
    if (visible) {
      const init: Record<string, string> = {};
      for (const cat of BREAKDOWN_CATEGORIES) {
        init[cat] = initialBreakdown?.[cat] != null ? String(initialBreakdown[cat]) : '';
      }
      setValues(init);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function handleChange(cat: string, raw: string) {
    setValues((prev) => ({ ...prev, [cat]: raw }));
  }

  async function handleSave() {
    const breakdown: Record<string, number> = {};
    for (const cat of BREAKDOWN_CATEGORIES) {
      const parsed = parseFloat(values[cat] ?? '');
      if (!isNaN(parsed) && parsed >= 0) breakdown[cat] = parsed;
    }
    setSaving(true);
    await onSave(breakdown);
    setSaving(false);
    onClose();
  }

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

  const total = BREAKDOWN_CATEGORIES.reduce((acc, cat) => {
    const v = parseFloat(values[cat] ?? '');
    return acc + (isNaN(v) ? 0 : v);
  }, 0);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.sandboxOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sandboxSheet}>
          {/* Header */}
          <View style={styles.sandboxHeader}>
            <Text style={styles.sandboxTitle}>Budget breakdown</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <X size={20} color={color.ink} />
            </Pressable>
          </View>
          <Text style={styles.sandboxSub}>
            Enter planned amounts per category. Leave blank to exclude a category.
          </Text>

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {BREAKDOWN_CATEGORIES.map((cat) => (
              <View key={cat} style={styles.sandboxInputGroup}>
                <Text style={styles.inputLabel}>
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </Text>
                <TextInput
                  style={styles.sandboxInput}
                  value={values[cat]}
                  onChangeText={(v) => handleChange(cat, v)}
                  keyboardType="numeric"
                  placeholder="e.g. 500"
                  placeholderTextColor={color.faint}
                  accessibilityLabel={`${cat} budget`}
                />
              </View>
            ))}

            {total > 0 && (
              <View style={styles.breakdownTotalRow}>
                <Text style={styles.breakdownTotalLabel}>Total entered</Text>
                <Text style={styles.breakdownTotalValue}>{fmt(total)}</Text>
              </View>
            )}
          </ScrollView>

          <Pressable
            style={[styles.sandboxRunBtn, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
          >
            {saving
              ? <ActivityIndicator color={color.onInk} size="small" />
              : <Text style={styles.sandboxRunBtnText}>Save breakdown</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Manual budget row
// ---------------------------------------------------------------------------

function ManualBudgetRow({
  budget, isOwner, onSave,
}: {
  budget: ManualBudget | null;
  isOwner: boolean;
  onSave: (amount: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(budget?.totalBudget != null ? String(budget.totalBudget) : '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    setValue(budget?.totalBudget != null ? String(budget.totalBudget) : '');
  }, [budget?.totalBudget]);

  async function handleBlur() {
    setEditing(false);
    const parsed = parseFloat(value);
    const newAmount = value.trim() === '' ? null : isNaN(parsed) ? null : parsed;
    const current = budget?.totalBudget ?? null;
    if (newAmount === current) return;
    setSaving(true);
    await onSave(newAmount);
    setSaving(false);
  }

  const currency = budget?.currency ?? 'USD';

  return (
    <View style={styles.manualRow}>
      <Text style={styles.manualLabel}>Budget</Text>
      {isOwner ? (
        editing ? (
          <TextInput
            ref={inputRef}
            style={styles.manualInput}
            value={value}
            onChangeText={setValue}
            keyboardType="numeric"
            onBlur={handleBlur}
            placeholder="Enter amount"
            placeholderTextColor={color.faint}
            accessibilityLabel="Trip budget amount"
          />
        ) : (
          <Pressable
            style={styles.manualValueBtn}
            onPress={() => { setEditing(true); }}
            accessibilityRole="button"
            accessibilityLabel="Edit trip budget"
          >
            {saving
              ? <ActivityIndicator size="small" color={color.mute} />
              : (
                <Text style={styles.manualValue}>
                  {budget?.totalBudget != null
                    ? formatCurrency(budget.totalBudget, currency)
                    : 'Tap to set budget'}
                </Text>
              )}
          </Pressable>
        )
      ) : (
        <Text style={styles.manualValue}>
          {budget?.totalBudget != null
            ? formatCurrency(budget.totalBudget, currency)
            : '—'}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TripBudgetSection({ tripId, isOwnerOrCohost, isOwner }: TripBudgetSectionProps) {
  const [estimate, setEstimate] = useState<CostEstimate | null | undefined>(undefined);
  const [budget, setBudget] = useState<ManualBudget | null>(null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownEditOpen, setBreakdownEditOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [est, bud] = await Promise.all([
        fetchCostEstimate(tripId),
        isOwnerOrCohost ? fetchManualBudget(tripId) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setEstimate(est);
      setBudget(bud);
    }

    load();
    return () => { cancelled = true; };
  }, [tripId, isOwnerOrCohost]);

  async function handleSaveBudget(amount: number | null) {
    const updated = await updateManualBudget(tripId, { totalBudget: amount });
    if (updated) setBudget(updated);
  }

  async function handleSaveBreakdown(breakdown: Record<string, number>) {
    const sum = Object.values(breakdown).reduce((acc, v) => acc + v, 0);
    const currentTotal = budget?.totalBudget ?? null;
    const data: Parameters<typeof updateManualBudget>[1] = { breakdown };
    // Auto-fill totalBudget from the category sum when it differs from the
    // current value (or when no total has been set yet), so owners don't have
    // to type it twice.
    if (sum > 0 && sum !== currentTotal) {
      data.totalBudget = sum;
    }
    const updated = await updateManualBudget(tripId, data);
    if (updated) setBudget(updated);
  }

  // Still loading
  if (estimate === undefined) return null;

  // Flag off — hide section entirely
  if (estimate === null) return null;

  const currency = estimate.available ? estimate.currency : 'USD';

  return (
    <View style={styles.section}>
      {/* Section header */}
      <View style={styles.sectionHeader}>
        <DollarSign size={16} color={color.deep} />
        <Text style={styles.sectionTitle}>Budget</Text>
      </View>

      {/* Manual budget row — owner/co-host only */}
      {isOwnerOrCohost && (
        <>
          <ManualBudgetRow budget={budget} isOwner={isOwner} onSave={handleSaveBudget} />

          {/* Spending breakdown — shown when breakdown data exists, or owner can create one */}
          {(budget?.breakdown && Object.keys(budget.breakdown).length > 0) ? (
            <View style={styles.breakdownCard}>
              <View style={styles.breakdownToggleRow}>
                <Pressable
                  style={styles.breakdownToggle}
                  onPress={() => setBreakdownOpen((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={breakdownOpen ? 'Collapse breakdown' : 'Expand breakdown'}
                >
                  <Text style={styles.breakdownToggleText}>Breakdown</Text>
                  {breakdownOpen
                    ? <ChevronUp size={14} color={color.mute} />
                    : <ChevronDown size={14} color={color.mute} />}
                </Pressable>
                {isOwner && (
                  <Pressable
                    onPress={() => setBreakdownEditOpen(true)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Edit budget breakdown"
                  >
                    <Text style={styles.breakdownEditLink}>Edit</Text>
                  </Pressable>
                )}
              </View>

              {breakdownOpen && (
                <View style={styles.breakdownList}>
                  {(Object.entries(budget.breakdown) as [string, number][])
                    .filter(([, v]) => typeof v === 'number')
                    .map(([cat, amount]) => (
                      <View key={cat} style={styles.breakdownRow}>
                        <Text style={styles.breakdownLabel}>
                          {cat.charAt(0).toUpperCase() + cat.slice(1)}
                        </Text>
                        <Text style={styles.breakdownValue}>
                          {formatCurrency(amount, budget.currency ?? 'USD')}
                        </Text>
                      </View>
                    ))}
                </View>
              )}
            </View>
          ) : isOwner ? (
            <Pressable
              style={styles.setBreakdownBtn}
              onPress={() => setBreakdownEditOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Set budget breakdown by category"
            >
              <Text style={styles.setBreakdownBtnText}>+ Set breakdown by category</Text>
            </Pressable>
          ) : null}
        </>
      )}

      {/* Cost estimate */}
      {estimate.available ? (
        <View style={styles.estimateCard}>
          <View style={styles.estimateHeader}>
            <Text style={styles.estimateLabel}>AI cost estimate</Text>
            {estimate.confidence ? <ConfidenceChip confidence={estimate.confidence} /> : null}
          </View>

          {estimate.perDay && (
            <BandRow label="Per day" band={estimate.perDay} currency={currency} />
          )}
          {estimate.total && (
            <BandRow label="Total trip" band={estimate.total} currency={currency} />
          )}

          {/* Assumptions toggle */}
          {estimate.assumptions && estimate.assumptions.length > 0 && (
            <Pressable
              style={styles.assumptionsToggle}
              onPress={() => setAssumptionsOpen((v) => !v)}
              accessibilityRole="button"
            >
              <Text style={styles.assumptionsToggleText}>Assumptions</Text>
              {assumptionsOpen
                ? <ChevronUp size={14} color={color.mute} />
                : <ChevronDown size={14} color={color.mute} />}
            </Pressable>
          )}
          {assumptionsOpen && estimate.assumptions && (
            <View style={styles.assumptionsList}>
              {estimate.assumptions.map((a, i) => (
                <Text key={i} style={styles.assumptionItem}>· {a}</Text>
              ))}
            </View>
          )}

          {/* Last verified */}
          {estimate.lastVerifiedAt && (
            <Text style={styles.lastVerified}>
              Last verified {new Date(estimate.lastVerifiedAt).toLocaleDateString()}
            </Text>
          )}

          <Text style={styles.disclaimer}>
            {estimate.disclaimer ?? 'Figures are estimates and may vary based on travel style and timing.'}
          </Text>

          {/* What if button */}
          <Pressable
            style={styles.whatIfBtn}
            onPress={() => setSandboxOpen(true)}
            accessibilityRole="button"
          >
            <Sliders size={14} color={color.signal} />
            <Text style={styles.whatIfBtnText}>What if…</Text>
          </Pressable>
        </View>
      ) : (
        /* Unavailable state — show reason honestly */
        <View style={styles.unavailableBox}>
          <Text style={styles.unavailableText}>
            {estimate.reason ?? 'No cost estimate available for this destination yet.'}
          </Text>
        </View>
      )}

      <WhatIfSandboxSheet
        tripId={tripId}
        visible={sandboxOpen}
        onClose={() => setSandboxOpen(false)}
      />

      {isOwner && (
        <BreakdownEditSheet
          visible={breakdownEditOpen}
          initialBreakdown={budget?.breakdown ?? null}
          currency={budget?.currency ?? 'USD'}
          onClose={() => setBreakdownEditOpen(false)}
          onSave={handleSaveBreakdown}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  section: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    marginBottom: space.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.md,
  },
  sectionTitle: {
    ...t.heading,
    color: color.ink,
  },

  // Manual budget
  manualRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    marginBottom: space.md,
    ...shadow.card,
  },
  manualLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  manualValueBtn: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  manualValue: {
    ...t.bodyStrong,
    color: color.signal,
  },
  manualInput: {
    ...t.bodyStrong,
    color: color.ink,
    borderBottomWidth: 1,
    borderBottomColor: color.signal,
    minWidth: 120,
    textAlign: 'right',
    paddingVertical: space.xs,
  },

  // Breakdown
  breakdownCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
    ...shadow.card,
  },
  breakdownToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  breakdownToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  breakdownToggleText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  breakdownEditLink: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
  },
  breakdownList: {
    gap: space.xs,
    paddingTop: space.sm,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  breakdownLabel: {
    ...t.body,
    color: color.ink,
  },
  breakdownValue: {
    ...t.bodyStrong,
    color: color.ink,
    fontVariant: ['tabular-nums'],
  },
  // "Set breakdown" button when no breakdown exists yet
  setBreakdownBtn: {
    alignSelf: 'flex-start',
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  setBreakdownBtnText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  // Breakdown edit sheet total row
  breakdownTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  breakdownTotalLabel: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  breakdownTotalValue: {
    ...t.bodyStrong,
    color: color.ink,
    fontVariant: ['tabular-nums'],
  },

  // Estimate card
  estimateCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
    ...shadow.card,
  },
  estimateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  estimateLabel: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Band row
  bandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bandLabel: {
    ...t.body,
    color: color.ink,
  },
  bandValue: {
    ...t.bodyStrong,
    color: color.ink,
    fontVariant: ['tabular-nums'],
  },

  // Confidence chip
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  // Assumptions
  assumptionsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: space.xs,
  },
  assumptionsToggleText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  assumptionsList: {
    gap: 3,
    paddingLeft: space.sm,
  },
  assumptionItem: {
    ...t.small,
    color: color.mute,
  },

  // Meta
  lastVerified: {
    ...t.stamp,
    color: color.faint,
    marginTop: space.xs,
  },
  disclaimer: {
    ...t.small,
    color: color.faint,
    fontStyle: 'italic',
    marginTop: space.xs,
  },

  // What if button
  whatIfBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.signal,
  },
  whatIfBtnText: {
    ...t.small,
    fontWeight: '700',
    color: color.signal,
  },

  // Unavailable
  unavailableBox: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.haze,
  },
  unavailableText: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
  },

  // Sandbox sheet
  sandboxOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(17,17,15,0.5)',
  },
  sandboxSheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.xl,
    maxHeight: '85%',
    ...shadow.float,
  },
  sandboxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  sandboxTitle: {
    ...t.heading,
    color: color.ink,
  },
  sandboxSub: {
    ...t.small,
    color: color.mute,
    marginBottom: space.lg,
  },
  sandboxInputGroup: {
    marginBottom: space.md,
  },
  inputLabel: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
    marginBottom: space.xs,
  },
  sandboxInput: {
    ...t.body,
    color: color.ink,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.paperRaised,
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.xs,
  },
  catChip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  catChipActive: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  catChipText: {
    ...t.small,
    color: color.ink,
    fontWeight: '600',
  },
  catChipTextActive: {
    color: color.onInk,
  },
  sandboxRunBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.lg,
  },
  sandboxRunBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
  sandboxResult: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
    marginTop: space.md,
    ...shadow.card,
  },
  sandboxResultTitle: {
    ...t.small,
    color: color.mute,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: space.xs,
  },
  sandboxResultNote: {
    ...t.small,
    color: color.faint,
    marginTop: space.xs,
  },
  sandboxError: {
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: '#FBE9E7',
    marginTop: space.md,
  },
  sandboxErrorText: {
    ...t.small,
    color: '#BF360C',
  },
});
