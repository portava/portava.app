/**
 * Start a Discovery Trail (`11` §3 action: propose; `02` §5–§6).
 *
 * A proposal the catalogue refuses (§5's checks) is not an error: the screen
 * says which check refused it and, when the server suggests a parent (§6),
 * offers to propose it again as a sub-Trail of that parent. Nothing is shown as
 * created until the server answered 201 with the Trail.
 */
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native';

import { color, space } from '../../../theme/tokens.ts';
import { ds } from '../shared/discoveryStyles.ts';
import { proposeTrail, type ProposeResult, type Trail } from './trailsApi.ts';
import { canonicalCheckCopy } from './trailModel.ts';

interface Props {
  initialDestination?: string | null;
  onCreated: (trail: Trail) => void;
  propose?: typeof proposeTrail;
}

export function TrailCreateForm({ initialDestination = null, onCreated, propose = proposeTrail }: Props) {
  const [title, setTitle] = useState('');
  const [destination, setDestination] = useState(initialDestination ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProposeResult | null>(null);

  const valid = title.trim().length >= 2 && title.trim().length <= 120;

  const submit = async (parentTrailId: string | null) => {
    if (!valid) return;
    setBusy(true); setResult(null);
    const r = await propose({ title, destination, description, parentTrailId });
    setBusy(false);
    if (r.state === 'created') onCreated(r.trail);
    else setResult(r);
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" testID="trail-create">
      <TextInput style={ds.input} value={title} onChangeText={setTitle} placeholder="Trail name, e.g. Kyoto Hidden Temples" maxLength={120} accessibilityLabel="Trail name" testID="trail-create-title" />
      <TextInput style={ds.input} value={destination} onChangeText={setDestination} placeholder="City (optional)" maxLength={120} accessibilityLabel="City" testID="trail-create-destination" />
      <TextInput style={[ds.input, { minHeight: 88, textAlignVertical: 'top' }]} value={description} onChangeText={setDescription} placeholder="What is this Trail about? (optional)" multiline maxLength={2000} accessibilityLabel="Description" testID="trail-create-description" />
      {!valid && title.length > 0 ? <Text style={[ds.detail, { paddingHorizontal: space.lg }]}>A Trail name needs 2 to 120 characters.</Text> : null}
      <Pressable style={[ds.button, (!valid || busy) && { opacity: 0.5 }]} onPress={() => { void submit(null); }} disabled={!valid || busy} accessibilityRole="button" accessibilityState={{ disabled: !valid || busy, busy }} testID="trail-create-submit">
        {busy ? <ActivityIndicator color={color.onInk} /> : <Text style={ds.buttonText}>Start this Trail</Text>}
      </Pressable>

      {result?.state === 'canonicalization_refused' ? (
        <View style={[ds.card, { padding: space.lg }]} testID="trail-create-refused">
          <Text style={ds.title}>This Trail can't be started as it is.</Text>
          {result.checks.length > 0
            ? result.checks.map((c, i) => <Text key={`${c.check}:${i}`} style={ds.detail}>{canonicalCheckCopy(c.check)}</Text>)
            : <Text style={ds.detail}>It overlaps the Trails that already exist.</Text>}
          {result.suggestedParentTrailId ? (
            <Pressable onPress={() => { void submit(result.suggestedParentTrailId); }} disabled={busy} accessibilityRole="button" testID="trail-create-as-child" style={{ marginTop: space.sm }}>
              <Text style={ds.link}>Start it inside the existing Trail instead</Text>
            </Pressable>
          ) : null}
        </View>
      ) : result?.state === 'refused' ? (
        <Text style={[ds.warn, { padding: space.lg }]} testID="trail-create-error">{result.detail}</Text>
      ) : result?.state === 'unavailable' ? (
        <Text style={[ds.warn, { padding: space.lg }]} testID="trail-create-error">Not started — {result.detail}. Try again.</Text>
      ) : null}
    </ScrollView>
  );
}
