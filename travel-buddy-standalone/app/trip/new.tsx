import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, ActivityIndicator, ScrollView,
  StyleSheet, Switch, Alert,
} from 'react-native';
import { router } from 'expo-router';
import {
  ChevronLeft, ChevronRight, MapPin, CalendarDays, X,
  Globe, Lock, Users, UserCheck, Compass, Check,
  Briefcase, Waves, Coffee, Moon, Plane, Sunset, Zap,
} from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { createTrip, updateTrip } from '../../src/services/trips';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { color, space, radius, type as ttype } from '../../src/theme/tokens';
import { formatDisplayDate, fromISODate } from '../../src/lib/dateTime/formatters';
import type { Place } from '../../src/lib/location/placeTypes';
import type { TripVisibility } from '../../src/types/models';

/* ─── Templates ─────────────────────────────────────────────────────────────── */

interface TmplDef {
  id: string; label: string; emoji: string; tripType: string;
  vibes: string[]; checklist: string[]; bg: string;
}

const TEMPLATES: TmplDef[] = [
  { id: 'weekend', label: 'Weekend', emoji: '🌅', tripType: 'weekend', vibes: ['relaxed', 'local'], checklist: ['Pack light bag', 'Book accommodation', 'Plan activities'], bg: '#E8A838' },
  { id: 'solo', label: 'Solo', emoji: '🧭', tripType: 'solo', vibes: ['adventure', 'independent'], checklist: ['Travel insurance', 'Share itinerary', 'Download offline maps'], bg: '#5B4FCF' },
  { id: 'group', label: 'Group', emoji: '👥', tripType: 'group', vibes: ['social', 'fun'], checklist: ['Coordinate schedules', 'Group chat', 'Split costs app'], bg: '#1A8C4E' },
  { id: 'nightlife', label: 'Nightlife', emoji: '🌙', tripType: 'nightlife', vibes: ['nightlife', 'party', 'social'], checklist: ['Research venues', 'Book tables', 'Plan transport home'], bg: '#2B1B6B' },
  { id: 'food', label: 'Foodie', emoji: '☕', tripType: 'food', vibes: ['foodie', 'local', 'culture'], checklist: ['Research restaurants', 'Make reservations', 'Download food map'], bg: '#C84B31' },
  { id: 'beach', label: 'Beach', emoji: '🌊', tripType: 'beach', vibes: ['relaxed', 'beach', 'outdoors'], checklist: ['Sunscreen', 'Beach gear', 'Book resort'], bg: '#0794D4' },
  { id: 'business', label: 'Business', emoji: '💼', tripType: 'business', vibes: ['productive', 'professional'], checklist: ['Book meetings', 'Expense tracker', 'Pack formal wear'], bg: '#2C3E50' },
  { id: 'nomad', label: 'Nomad', emoji: '⚡', tripType: 'digital_nomad', vibes: ['productive', 'adventure', 'independent'], checklist: ['Find coworking spaces', 'Check internet speed', 'Monthly accommodation'], bg: '#8E44AD' },
];

/* ─── Wizard state ───────────────────────────────────────────────────────────── */

interface WState {
  draftId: string | null;
  templateId: string | null;
  tripType: string | null;
  title: string;
  place: Place | null;
  startDate: string | null;
  endDate: string | null;
  flexibleDates: boolean;
  noDates: boolean;
  vibes: string[];
  visibility: TripVisibility;
  allowJoinRequests: boolean;
  showOnProfile: boolean;
  showExactDates: boolean;
  delayedPosting: boolean;
  budgetTotal: string;
  budgetCurrency: string;
  safeReturn: boolean;
}

const INIT: WState = {
  draftId: null, templateId: null, tripType: null, title: '', place: null,
  startDate: null, endDate: null, flexibleDates: false, noDates: false,
  vibes: [], visibility: 'private', allowJoinRequests: false, showOnProfile: true,
  showExactDates: true, delayedPosting: false, budgetTotal: '', budgetCurrency: 'USD',
  safeReturn: false,
};

const VIBES = [
  'adventure', 'relaxed', 'cultural', 'foodie', 'nightlife', 'beach',
  'outdoors', 'social', 'romantic', 'family', 'luxury', 'budget', 'photography',
];

const VIS_OPTS: { key: TripVisibility; label: string; sub: string }[] = [
  { key: 'private', label: 'Private', sub: 'Only you & invited crew' },
  { key: 'invite', label: 'Invite only', sub: 'Anyone with a link or invite' },
  { key: 'buddies', label: 'Friends', sub: 'Visible to your mutual follows' },
  { key: 'public', label: 'Public', sub: 'Anyone can discover it' },
];

const TRIP_TYPES = [
  'solo', 'friends', 'group', 'business', 'family', 'nightlife',
  'food', 'beach', 'adventure', 'digital_nomad', 'layover', 'weekend',
];

const TOTAL = 9;

/* ─── Component ──────────────────────────────────────────────────────────────── */

export default function NewTrip() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;

  const [step, setStep] = useState(0);
  const [ws, setWS] = useState<WState>(INIT);
  const [busy, setBusy] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);

  function upd(patch: Partial<WState>) { setWS((s) => ({ ...s, ...patch })); }

  function applyTemplate(tmpl: TmplDef) {
    upd({ templateId: tmpl.id, tripType: tmpl.tripType, vibes: tmpl.vibes });
  }

  function validate() {
    if (step === 1) {
      if (!ws.title.trim()) return 'Add a trip name.';
      if (!ws.place) return 'Choose a destination.';
    }
    if (step === 2 && ws.startDate && ws.endDate && !ws.noDates) {
      if (new Date(ws.startDate) > new Date(ws.endDate)) return 'End date must be after start.';
    }
    return null;
  }

  async function saveDraft() {
    if (!live || savingDraft) return;
    setSavingDraft(true);
    try {
      const base = {
        title: ws.title.trim() || 'Draft trip',
        destinationCity: ws.place?.city ?? ws.place?.name ?? 'TBD',
        destinationCountry: ws.place?.country ?? undefined,
        destinationLat: ws.place?.lat ?? undefined,
        destinationLng: ws.place?.lng ?? undefined,
        destinationPlaceId: ws.place?.id ?? undefined,
        startDate: ws.noDates ? undefined : ws.startDate ?? undefined,
        endDate: ws.noDates ? undefined : ws.endDate ?? undefined,
        status: 'draft' as const,
        visibility: ws.visibility,
        tripType: ws.tripType ?? undefined,
        allowJoinRequests: ws.allowJoinRequests,
        showOnProfile: ws.showOnProfile,
        showExactDates: ws.showExactDates,
        delayedPostingDefault: ws.delayedPosting,
      };
      if (!ws.draftId) {
        const t = await createTrip(base);
        if (t) upd({ draftId: t.id });
      } else {
        await updateTrip(ws.draftId, base);
      }
    } catch { /* silent */ } finally { setSavingDraft(false); }
  }

  function handleBack() {
    setErr(null);
    if (step === 0) router.back();
    else setStep((s) => s - 1);
  }

  async function handleContinue() {
    const vErr = validate();
    if (vErr) { setErr(vErr); return; }
    setErr(null);
    void saveDraft();
    if (step < TOTAL - 1) { setStep((s) => s + 1); } else { await handleCreate(); }
  }

  async function handleCreate() {
    if (!ws.title.trim()) { setErr('Add a trip name.'); setStep(1); return; }
    if (!ws.place) { setErr('Choose a destination.'); setStep(1); return; }
    if (!live) { Alert.alert('Sign in required', 'Sign in to create trips.'); return; }
    setBusy(true); setErr(null);
    try {
      const input = {
        title: ws.title.trim(),
        destinationCity: ws.place.city ?? ws.place.name,
        destinationCountry: ws.place.country ?? undefined,
        destinationLat: ws.place.lat ?? undefined,
        destinationLng: ws.place.lng ?? undefined,
        destinationPlaceId: ws.place.id ?? undefined,
        startDate: ws.noDates ? undefined : ws.startDate ?? undefined,
        endDate: ws.noDates ? undefined : ws.endDate ?? undefined,
        status: 'planning' as const,
        visibility: ws.visibility,
        tripType: ws.tripType ?? undefined,
        allowJoinRequests: ws.allowJoinRequests,
        showOnProfile: ws.showOnProfile,
        showExactDates: ws.showExactDates,
        delayedPostingDefault: ws.delayedPosting,
      };
      let trip;
      if (ws.draftId) {
        trip = await updateTrip(ws.draftId, { ...input, status: 'planning' });
      } else {
        trip = await createTrip(input);
      }
      if (!trip) throw new Error('Trip could not be created. Please try again.');
      router.replace(`/trip/${trip.id}`);
    } catch (e: any) {
      setErr(e?.message ?? 'Something went wrong.');
    } finally { setBusy(false); }
  }

  const pct = ((step + 1) / TOTAL) * 100;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader
        title={`New trip  ${step + 1}/${TOTAL}`}
        back={false}
        left={
          <Pressable onPress={handleBack} hitSlop={8} style={g.hBtn}>
            <ChevronLeft size={20} color={color.ink} />
          </Pressable>
        }
        right={
          live && step > 0 ? (
            <Pressable onPress={saveDraft} hitSlop={8} style={g.hBtn} disabled={savingDraft}>
              {savingDraft
                ? <ActivityIndicator size="small" color={color.mute} />
                : <Text style={g.draftTxt}>Save draft</Text>}
            </Pressable>
          ) : undefined
        }
      />

      <View style={g.track}><View style={[g.fill, { width: `${pct}%` as any }]} /></View>

      <ScrollView contentContainerStyle={g.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {err && <View style={g.errBanner}><Text style={g.errTxt}>{err}</Text></View>}

        {step === 0 && <StepTemplate ws={ws} onSelect={applyTemplate} />}
        {step === 1 && (
          <StepDest
            ws={ws}
            onTitle={(v) => upd({ title: v })}
            onClear={() => upd({ place: null })}
            onOpenPlace={() => setPlaceOpen(true)}
          />
        )}
        {step === 2 && (
          <StepDates
            ws={ws}
            onOpenCal={() => setCalOpen(true)}
            onClear={() => upd({ startDate: null, endDate: null })}
            onFlex={(v) => upd({ flexibleDates: v, noDates: false })}
            onNoDate={(v) => upd({ noDates: v, flexibleDates: false, startDate: null, endDate: null })}
          />
        )}
        {step === 3 && <StepStyle ws={ws} onVibe={(v) => upd({ vibes: ws.vibes.includes(v) ? ws.vibes.filter((x) => x !== v) : [...ws.vibes, v] })} onType={(v) => upd({ tripType: v })} />}
        {step === 4 && <StepPrivacy ws={ws} upd={upd} />}
        {step === 5 && <StepCrew />}
        {step === 6 && <StepBudget ws={ws} onAmt={(v) => upd({ budgetTotal: v })} onCur={(v) => upd({ budgetCurrency: v })} />}
        {step === 7 && <StepSafety ws={ws} onToggle={(v) => upd({ safeReturn: v })} />}
        {step === 8 && <StepSummary ws={ws} />}
      </ScrollView>

      <View style={g.nav}>
        <Pressable style={g.backBtn} onPress={handleBack} hitSlop={4}>
          <ChevronLeft size={16} color={color.ink} />
          <Text style={g.backTxt}>Back</Text>
        </Pressable>
        <Pressable style={[g.continueBtn, busy && { opacity: 0.7 }]} onPress={handleContinue} disabled={busy}>
          {busy
            ? <ActivityIndicator color={color.onInk} />
            : <>
                <Text style={g.continueTxt}>{step === TOTAL - 1 ? 'Create Trip' : 'Continue'}</Text>
                {step < TOTAL - 1 && <ChevronRight size={16} color={color.onInk} />}
              </>}
        </Pressable>
      </View>

      <GlobalCalendarPicker
        mode="range" visible={calOpen}
        value={{ start: ws.startDate, end: ws.endDate }}
        allowPast
        onConfirm={({ start, end }) => { upd({ startDate: start, endDate: end, noDates: false }); setCalOpen(false); }}
        onCancel={() => setCalOpen(false)}
        title="Trip Dates"
      />

      <GlobalPlacePicker
        visible={placeOpen} title="Destination" allowGPS={false} usedFor="trip_destination"
        onSelect={(p) => { upd({ place: p }); setPlaceOpen(false); }}
        onClose={() => setPlaceOpen(false)}
      />
    </View>
  );
}

/* ─── Step 0 — Template ─────────────────────────────────────────────────────── */
function StepTemplate({ ws, onSelect }: { ws: WState; onSelect: (t: TmplDef) => void }) {
  return (
    <View style={s0.wrap}>
      <Text style={g.h2}>What kind of trip?</Text>
      <Text style={g.sub}>Pick a template — you can customize everything after.</Text>
      <View style={s0.grid}>
        {TEMPLATES.map((tmpl) => {
          const on = ws.templateId === tmpl.id;
          return (
            <Pressable key={tmpl.id} style={[s0.card, on && { borderColor: tmpl.bg, backgroundColor: tmpl.bg + '12' }]} onPress={() => onSelect(tmpl)}>
              <View style={[s0.ic, { backgroundColor: on ? tmpl.bg : color.haze }]}>
                <Text style={{ fontSize: 22 }}>{tmpl.emoji}</Text>
              </View>
              <Text style={[s0.lbl, on && { color: tmpl.bg }]}>{tmpl.label}</Text>
              {on && <View style={s0.check}><Check size={12} color={tmpl.bg} /></View>}
            </Pressable>
          );
        })}
        <Pressable
          style={[s0.card, !ws.templateId && { borderColor: color.ink, backgroundColor: color.ink + '08' }]}
          onPress={() => onSelect({ id: '', label: 'Blank', emoji: '✦', tripType: '', vibes: [], checklist: [], bg: color.ink })}
        >
          <View style={[s0.ic, { backgroundColor: color.haze }]}><Text style={{ fontSize: 22 }}>✦</Text></View>
          <Text style={s0.lbl}>Blank</Text>
        </Pressable>
      </View>
    </View>
  );
}
const s0 = StyleSheet.create({
  wrap: { gap: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  card: { width: '47%', borderRadius: radius.lg, borderWidth: 1.5, borderColor: color.haze, padding: space.md, gap: 6, alignItems: 'center', position: 'relative', backgroundColor: color.paperRaised },
  ic: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  lbl: { ...ttype.small, color: color.ink, fontWeight: '600' as const, textAlign: 'center' as const },
  check: { position: 'absolute' as const, top: 6, right: 6 },
});

/* ─── Step 1 — Destination ──────────────────────────────────────────────────── */
function StepDest({ ws, onTitle, onClear, onOpenPlace }: { ws: WState; onTitle: (v: string) => void; onClear: () => void; onOpenPlace: () => void }) {
  return (
    <View style={{ gap: space.lg }}>
      <Text style={g.h2}>Where are you going?</Text>
      <View>
        <Text style={g.lbl}>Destination</Text>
        <Pressable style={g.picker} onPress={onOpenPlace}>
          <MapPin size={15} color={ws.place ? color.signal : color.faint} />
          <Text style={[g.pickerTxt, !ws.place && g.ph]} numberOfLines={1}>
            {ws.place ? ws.place.displayName : 'Choose a city…'}
          </Text>
          {ws.place && <Pressable hitSlop={8} onPress={onClear}><X size={14} color={color.mute} /></Pressable>}
        </Pressable>
      </View>
      <View>
        <Text style={g.lbl}>Trip name</Text>
        <TextInput
          style={g.input} autoCapitalize="words" value={ws.title} onChangeText={onTitle}
          placeholder={ws.place ? `${ws.place.city ?? ws.place.name} trip` : 'e.g. Tokyo June'}
          placeholderTextColor={color.faint}
        />
      </View>
    </View>
  );
}

/* ─── Step 2 — Dates ────────────────────────────────────────────────────────── */
function StepDates({ ws, onOpenCal, onClear, onFlex, onNoDate }: { ws: WState; onOpenCal: () => void; onClear: () => void; onFlex: (v: boolean) => void; onNoDate: (v: boolean) => void }) {
  const sD = ws.startDate ? fromISODate(ws.startDate) : null;
  const eD = ws.endDate ? fromISODate(ws.endDate) : null;
  const label = ws.noDates ? 'No dates set yet'
    : ws.flexibleDates ? 'Flexible dates'
    : sD && eD ? `${formatDisplayDate(sD)} – ${formatDisplayDate(eD)}`
    : sD ? `From ${formatDisplayDate(sD)}`
    : 'Pick dates…';
  return (
    <View style={{ gap: space.lg }}>
      <Text style={g.h2}>When are you going?</Text>
      <Pressable style={[g.picker, ws.noDates && { opacity: 0.45 }]} onPress={ws.noDates ? undefined : onOpenCal}>
        <CalendarDays size={15} color={(ws.startDate || ws.endDate) && !ws.noDates ? color.signal : color.faint} />
        <Text style={[g.pickerTxt, !(ws.startDate || ws.endDate) && g.ph]} numberOfLines={1}>{label}</Text>
        {(ws.startDate || ws.endDate) && !ws.noDates && <Pressable hitSlop={8} onPress={onClear}><X size={14} color={color.mute} /></Pressable>}
      </Pressable>
      <TRow label="Flexible dates" sub="Rough range, not confirmed" value={ws.flexibleDates} onChange={onFlex} />
      <TRow label="Dates not decided yet" sub="Plan now, confirm later" value={ws.noDates} onChange={onNoDate} />
    </View>
  );
}

/* ─── Step 3 — Style ────────────────────────────────────────────────────────── */
function StepStyle({ ws, onVibe, onType }: { ws: WState; onVibe: (v: string) => void; onType: (v: string) => void }) {
  return (
    <View style={{ gap: space.lg }}>
      <Text style={g.h2}>What's the vibe?</Text>
      <View>
        <Text style={g.lbl}>Trip type</Text>
        <View style={s3.chips}>
          {TRIP_TYPES.map((tp) => (
            <Pressable key={tp} style={[s3.chip, ws.tripType === tp && s3.on]} onPress={() => onType(tp)}>
              <Text style={[s3.txt, ws.tripType === tp && s3.onTxt]}>{tp.replace('_', ' ')}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View>
        <Text style={g.lbl}>Vibes (pick any)</Text>
        <View style={s3.chips}>
          {VIBES.map((v) => (
            <Pressable key={v} style={[s3.chip, ws.vibes.includes(v) && s3.on]} onPress={() => onVibe(v)}>
              <Text style={[s3.txt, ws.vibes.includes(v) && s3.onTxt]}>{v}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}
const s3 = StyleSheet.create({
  chips: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: space.sm, marginTop: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.haze, backgroundColor: color.paperRaised },
  on: { borderColor: color.ink, backgroundColor: color.ink },
  txt: { ...ttype.small, color: color.ink, fontWeight: '600' as const },
  onTxt: { color: color.onInk },
});

/* ─── Step 4 — Privacy ──────────────────────────────────────────────────────── */
function StepPrivacy({ ws, upd }: { ws: WState; upd: (p: Partial<WState>) => void }) {
  return (
    <View style={{ gap: space.md }}>
      <Text style={g.h2}>Privacy settings</Text>
      <View style={{ gap: space.sm }}>
        {VIS_OPTS.map((opt) => (
          <Pressable key={opt.key} style={[s4.card, ws.visibility === opt.key && s4.on]} onPress={() => upd({ visibility: opt.key })}>
            <View style={{ flex: 1 }}>
              <Text style={s4.lbl}>{opt.label}</Text>
              <Text style={s4.sub}>{opt.sub}</Text>
            </View>
            {ws.visibility === opt.key && <Check size={16} color={color.ink} />}
          </Pressable>
        ))}
      </View>
      <TRow label="Allow join requests" sub="Others can request to join" value={ws.allowJoinRequests} onChange={(v) => upd({ allowJoinRequests: v })} />
      <TRow label="Show on profile" sub="Appear in your travel passport" value={ws.showOnProfile} onChange={(v) => upd({ showOnProfile: v })} />
      <TRow label="Show exact dates" sub="Visible to permitted viewers" value={ws.showExactDates} onChange={(v) => upd({ showExactDates: v })} />
      <TRow label="Delayed posting" sub="Posts publish after you return" value={ws.delayedPosting} onChange={(v) => upd({ delayedPosting: v })} />
    </View>
  );
}
const s4 = StyleSheet.create({
  card: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.md, borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.lg, padding: space.md, backgroundColor: color.paperRaised },
  on: { borderColor: color.ink, backgroundColor: color.ink + '08' },
  lbl: { ...ttype.body, color: color.ink, fontWeight: '600' as const },
  sub: { ...ttype.small, color: color.mute },
});

/* ─── Step 5 — Crew ─────────────────────────────────────────────────────────── */
function StepCrew() {
  return (
    <View style={s5.wrap}>
      <View style={s5.ic}><Users size={40} color={color.signal} /></View>
      <Text style={g.h2}>Trip crew</Text>
      <Text style={[g.sub, { textAlign: 'center' as const }]}>Invite crew after the trip is created. Head to the Crew screen on your trip to send invites, set roles, and manage permissions.</Text>
      <View style={s5.box}>
        <Text style={s5.bTitle}>After you create:</Text>
        {['Invite by username or link', 'Set roles: co-host, member, viewer', 'Control per-member permissions', 'Approve join requests'].map((i) => (
          <Text key={i} style={s5.bItem}>· {i}</Text>
        ))}
      </View>
    </View>
  );
}
const s5 = StyleSheet.create({
  wrap: { alignItems: 'center' as const, gap: space.lg, paddingTop: space.xl },
  ic: { width: 80, height: 80, borderRadius: 24, backgroundColor: color.signal + '15', alignItems: 'center' as const, justifyContent: 'center' as const },
  box: { alignSelf: 'stretch' as const, backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.lg, gap: space.xs, borderWidth: 1, borderColor: color.haze },
  bTitle: { ...ttype.small, color: color.ink, fontWeight: '700' as const, marginBottom: space.xs },
  bItem: { ...ttype.small, color: color.mute },
});

/* ─── Step 6 — Budget ───────────────────────────────────────────────────────── */
function StepBudget({ ws, onAmt, onCur }: { ws: WState; onAmt: (v: string) => void; onCur: (v: string) => void }) {
  return (
    <View style={{ gap: space.lg }}>
      <Text style={g.h2}>Budget (optional)</Text>
      <Text style={g.sub}>Private by default — only you see it unless you share with crew.</Text>
      <View>
        <Text style={g.lbl}>Total budget</Text>
        <View style={{ flexDirection: 'row' as const, gap: space.sm, marginTop: space.sm }}>
          <TextInput
            style={[g.input, { width: 64, textAlign: 'center' as const, fontWeight: '700' as const }]}
            value={ws.budgetCurrency} onChangeText={onCur}
            autoCapitalize="characters" maxLength={3}
            placeholder="USD" placeholderTextColor={color.faint}
          />
          <TextInput
            style={[g.input, { flex: 1 }]}
            value={ws.budgetTotal} onChangeText={onAmt}
            keyboardType="numeric" placeholder="0" placeholderTextColor={color.faint}
          />
        </View>
      </View>
      <View style={{ backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.md, borderWidth: 1, borderColor: color.haze }}>
        <Text style={g.sub}>Not sure yet? Add budget details from the Trip Detail screen any time.</Text>
      </View>
    </View>
  );
}

/* ─── Step 7 — Safety ───────────────────────────────────────────────────────── */
function StepSafety({ ws, onToggle }: { ws: WState; onToggle: (v: boolean) => void }) {
  return (
    <View style={{ gap: space.lg }}>
      <Text style={g.h2}>Trip safety</Text>
      <TRow label="Enable Safe Return" sub="Set a check-in timer — your crew is alerted if you don't check in." value={ws.safeReturn} onChange={onToggle} />
      <View style={{ backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.md, gap: space.sm, borderWidth: 1, borderColor: color.haze }}>
        <Text style={{ ...ttype.small, color: color.ink, fontWeight: '700' as const }}>About Safe Return</Text>
        <Text style={g.sub}>Set a countdown timer. If you don't check in before it expires, your chosen contacts are notified. Configure fully from Trip Detail after creating.</Text>
      </View>
    </View>
  );
}

/* ─── Step 8 — Summary ──────────────────────────────────────────────────────── */
function StepSummary({ ws }: { ws: WState }) {
  const sD = ws.startDate ? fromISODate(ws.startDate) : null;
  const eD = ws.endDate ? fromISODate(ws.endDate) : null;
  const dateStr = ws.noDates ? 'No dates set'
    : ws.flexibleDates ? 'Flexible'
    : sD && eD ? `${formatDisplayDate(sD)} – ${formatDisplayDate(eD)}`
    : 'No dates set';
  const visLabel = VIS_OPTS.find((o) => o.key === ws.visibility)?.label ?? 'Private';
  const rows = [
    ['Trip name', ws.title.trim() || '—'],
    ['Destination', ws.place?.displayName ?? '—'],
    ['Dates', dateStr],
    ...(ws.tripType ? [['Type', ws.tripType.replace('_', ' ')]] : []),
    ...(ws.vibes.length ? [['Vibes', ws.vibes.join(', ')]] : []),
    ['Visibility', visLabel],
    ['Join requests', ws.allowJoinRequests ? 'Allowed' : 'Off'],
  ] as [string, string][];
  return (
    <View style={{ gap: space.lg }}>
      <Text style={g.h2}>Ready to create?</Text>
      <Text style={g.sub}>Review your details — you can edit everything after creating.</Text>
      <View style={s8.card}>
        {rows.map(([lbl, val], i) => (
          <View key={lbl} style={[s8.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
            <Text style={s8.rl}>{lbl}</Text>
            <Text style={s8.rv} numberOfLines={2}>{val}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
const s8 = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' as const },
  row: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingHorizontal: space.md, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.haze + '80' },
  rl: { ...ttype.small, color: color.mute, flex: 1 },
  rv: { ...ttype.small, color: color.ink, fontWeight: '600' as const, flex: 2, textAlign: 'right' as const },
});

/* ─── TRow ───────────────────────────────────────────────────────────────────── */
function TRow({ label, sub, value, onChange }: { label: string; sub: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={tr.row}>
      <View style={{ flex: 1 }}>
        <Text style={tr.lbl}>{label}</Text>
        <Text style={tr.sub}>{sub}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: color.haze, true: color.ink }} thumbColor={color.onInk} />
    </View>
  );
}
const tr = StyleSheet.create({
  row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.md, borderWidth: 1, borderColor: color.haze },
  lbl: { ...ttype.body, color: color.ink, fontWeight: '600' as const },
  sub: { ...ttype.small, color: color.mute, marginTop: 2 },
});

/* ─── Global styles ──────────────────────────────────────────────────────────── */
const g = StyleSheet.create({
  hBtn: { paddingHorizontal: space.sm },
  draftTxt: { ...ttype.small, color: color.mute, fontWeight: '600' as const },
  track: { height: 3, backgroundColor: color.haze },
  fill: { height: 3, backgroundColor: color.ink },
  scroll: { padding: space.lg, gap: space.lg, paddingBottom: 120 },
  errBanner: { backgroundColor: color.signal + '15', borderRadius: radius.md, padding: space.md },
  errTxt: { ...ttype.small, color: color.signal, fontWeight: '600' as const },
  h2: { ...ttype.title, color: color.ink, fontSize: 22 },
  sub: { ...ttype.small, color: color.mute },
  lbl: { ...ttype.stamp, color: color.mute, marginBottom: space.sm, fontSize: 11, letterSpacing: 0.5 },
  input: { ...ttype.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  picker: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.sm, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 50 },
  pickerTxt: { flex: 1, ...ttype.body, color: color.ink },
  ph: { color: color.faint },
  nav: { position: 'absolute' as const, bottom: 0, left: 0, right: 0, flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.sm, padding: space.lg, paddingBottom: space.xl, backgroundColor: color.paper, borderTopWidth: 1, borderTopColor: color.haze },
  backBtn: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  backTxt: { ...ttype.small, color: color.ink, fontWeight: '600' as const },
  continueBtn: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 4, paddingVertical: space.md, borderRadius: radius.pill, backgroundColor: color.ink },
  continueTxt: { ...ttype.body, fontWeight: '700' as const, color: color.onInk },
});
