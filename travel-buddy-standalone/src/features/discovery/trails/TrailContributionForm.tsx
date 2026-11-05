import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { ds } from '../shared/discoveryStyles.ts';
import { contributeToTrail, trailSourceFromLink, type ContributionResult } from './trailContribution.ts';

export function TrailContributionForm({ trailId, onDone, contribute = contributeToTrail }: {
  trailId: string; onDone: () => void; contribute?: typeof contributeToTrail;
}) {
  const [link, setLink] = useState('');
  const [relationship, setRelationship] = useState<'primary' | 'supporting'>('supporting');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContributionResult | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async () => {
    if (pending.current) return;
    const source = trailSourceFromLink(link);
    if (!source) { setResult({ state: 'failed', detail: 'Paste a Portava link to a post, place, event, or route.' }); return; }
    pending.current = true; setBusy(true); setResult(null);
    try {
      const answer = await contribute(trailId, source, relationship);
      if (alive.current) setResult(answer);
    } catch {
      if (alive.current) setResult({ state: 'failed', detail: 'The contribution could not be confirmed. Please try again.' });
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const succeeded = result?.state === 'added' || result?.state === 'suggested';
  return <View testID="trail-contribution-form">
    <Text style={ds.heading}>Add to this Trail</Text>
    {succeeded ? <Text style={ds.notice} testID="trail-contribution-success">
      {result.state === 'added' ? 'Added to this Trail.' : 'Suggestion sent. It will appear after the content owner approves it.'}
    </Text> : <>
      <Text style={ds.notice}>Share a Portava post, place, event, or route. Suggestions for someone else's content need their approval.</Text>
      <TextInput value={link} onChangeText={setLink} editable={!busy} placeholder="Paste a Portava link" autoCapitalize="none" autoCorrect={false}
        keyboardType="url" returnKeyType="done" onSubmitEditing={() => { void submit(); }} style={ds.input} accessibilityLabel="Portava content link" testID="trail-contribution-link" />
      <View style={ds.chips}>
        {(['primary', 'supporting'] as const).map((kind) => <Pressable key={kind} disabled={busy} style={[ds.ghost, relationship === kind && ds.ghostOn]}
          accessibilityRole="radio" accessibilityState={{ checked: relationship === kind }} testID={`trail-contribution-${kind}`} onPress={() => setRelationship(kind)}>
          <Text style={[ds.ghostText, relationship === kind && ds.ghostTextOn]}>{kind === 'primary' ? 'Main feature' : 'Related recommendation'}</Text>
        </Pressable>)}
      </View>
      {result?.state === 'failed' ? <Text style={ds.notice} accessibilityRole="alert" testID="trail-contribution-error">{result.detail}</Text> : null}
      <Pressable style={ds.button} accessibilityRole="button" disabled={busy} accessibilityState={{ busy }} testID="trail-contribution-submit" onPress={() => { void submit(); }}>
        <Text style={ds.buttonText}>{busy ? 'Sending…' : 'Add to Trail'}</Text>
      </Pressable>
    </>}
    <Pressable style={ds.button} accessibilityRole="button" disabled={busy} testID="trail-contribution-close" onPress={onDone}>
      <Text style={ds.buttonText}>{succeeded ? 'Done' : 'Cancel'}</Text>
    </Pressable>
  </View>;
}
