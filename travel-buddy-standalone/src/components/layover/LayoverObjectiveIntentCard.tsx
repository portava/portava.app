import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { objectiveIntentRequest, emptyObjectiveIntent, budgetAmount, displayBudget, type ObjectiveIntent } from '../../services/layoverObjectiveIntent.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
interface Props { sessionId: string; places: Array<{ placeId?: string | null; title: string }>; editable: boolean; onChanged: () => void }
export function LayoverObjectiveIntentCard(props: Props) { return <SessionIntentCard key={props.sessionId} {...props} />; }
function SessionIntentCard({ sessionId, places, editable, onChanged }: Props) {
  const [intent, setIntent] = useState<ObjectiveIntent>(emptyObjectiveIntent), [ready, setReady] = useState(false), [available, setAvailable] = useState(true);
  const [currency, setCurrency] = useState(''), [amount, setAmount] = useState(''), [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const mounted = useRef(true), saving = useRef(false);
  useEffect(() => {
    let current = true;
    mounted.current = true;
    void objectiveIntentRequest(sessionId).then(r => {
      if (!current || !mounted.current) return;
      if (!r.ok) { setAvailable(r.reason !== 'feature_disabled'); setMessage('Your preferences could not be loaded. Try again when your layover refreshes.'); return; }
      setIntent(r.intent); setCurrency(r.intent.budget?.currency ?? ''); setAmount(r.intent.budget ? displayBudget(r.intent.budget) : ''); setReady(true);
    });
    return () => { current = false; mounted.current = false; };
  }, [sessionId, readVersion]);
  const save = async () => {
    if (!ready || !editable || saving.current) return;
    const budget = currency || amount ? budgetAmount(currency, amount) : null;
    if ((currency || amount) && !budget) { setMessage('Enter a currency code and a valid amount, or clear both to leave your budget unstated.'); return; }
    saving.current = true; setBusy(true); setMessage(null);
    try {
      const r = await objectiveIntentRequest(sessionId, { ...intent, budget });
      if (!mounted.current) return;
      if (!r.ok) { setMessage('Your preferences were not confirmed. Try saving again.'); return; }
      setIntent(r.intent); setMessage('Preferences saved. Refreshing your checked ideas.'); onChanged();
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  if (!available) return null;
  const unique = [...new Map(places.filter(p => p.placeId).map(p => [p.placeId!, p])).values()].slice(0, 20);
  const choice = (label: string, selected: boolean, action: () => void) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected, disabled: !ready || !editable || busy }} disabled={!ready || !editable || busy} onPress={action} style={{ padding: space.sm, borderRadius: radius.sm, backgroundColor: selected ? color.deep : color.paper }}><Text style={{ ...t.small, color: selected ? color.paper : color.ink }}>{label}</Text></Pressable>;
  return <View testID="objective-intent-card" style={{ backgroundColor: color.paperRaised, padding: space.lg, borderRadius: radius.md, gap: space.sm }}>
    <Text style={{ ...t.bodyStrong, color: color.ink }}>What matters for this outing?</Text>
    <Text style={{ ...t.small, color: color.mute }}>Your choices help order ideas that pass the safety checks. Cost is considered only with a complete, current quote in your budget’s currency.</Text>
    <Text style={{ ...t.small, color: color.ink }}>Company</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>{([['Quiet', 'quiet'], ['Social', 'social'], ['Either', 'either'], ['Not stated', null]] as const).map(([label, value]) => choice(label, intent.socialPreference === value, () => setIntent(i => ({ ...i, socialPreference: value }))))}</View>
    <Text style={{ ...t.small, color: color.ink }}>Energy available</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>{([['Low energy', 'low'], ['Some energy', 'medium'], ['Plenty of energy', 'high'], ['Energy not stated', null]] as const).map(([label, value]) => choice(label, intent.availableEnergy === value, () => setIntent(i => ({ ...i, availableEnergy: value }))))}</View>
    <TextInput accessibilityLabel="Budget currency" placeholder="Currency code, e.g. SGD" value={currency} onChangeText={v => setCurrency(v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))} editable={ready && editable && !busy} autoCapitalize="characters" />
    <TextInput accessibilityLabel="Outing budget" placeholder="Budget in that currency (optional)" value={amount} onChangeText={setAmount} editable={ready && editable && !busy} keyboardType="decimal-pad" />
    {unique.length ? <Text style={{ ...t.small, color: color.mute }}>Places that would be personally meaningful to visit. This records your intention, not a past memory.</Text> : null}
    {unique.map(p => choice(`Meaningful to me: ${p.title}`, intent.meaningfulPlaces.some(v => v.placeId === p.placeId), () => setIntent(i => ({ ...i, meaningfulPlaces: i.meaningfulPlaces.some(v => v.placeId === p.placeId) ? i.meaningfulPlaces.filter(v => v.placeId !== p.placeId) : [...i.meaningfulPlaces, { placeId: p.placeId!, importance: 'high' }] }))))}
    {message ? <Text accessibilityRole="alert" style={{ ...t.small, color: color.mute }}>{message}</Text> : null}
    {!ready ? <Pressable accessibilityRole="button" onPress={() => setReadVersion(v => v + 1)}><Text style={{ ...t.bodyStrong, color: color.deep }}>Reload preferences</Text></Pressable> : null}
    {editable ? <Pressable accessibilityRole="button" disabled={!ready || busy} onPress={() => { void save(); }}><Text style={{ ...t.bodyStrong, color: color.deep }}>{busy ? 'Saving preferences…' : 'Save preferences'}</Text></Pressable> : null}
  </View>;
}
