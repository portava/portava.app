import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePrivateSurfaceKey } from '../../../hooks/usePrivateSurfaceKey.ts';
import { useAiWritingAssist } from '../../../hooks/useAiWritingAssist.ts';
import { AiWritingAssist } from './AiWritingAssist.tsx';
import { color, space, type as typography } from '../../../theme/tokens.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';

type Props = {
  context: 'caption' | 'event_description' | 'plan_title';
  fieldId: string;
  text: string;
  onInsert: (text: string) => void;
  disabled?: boolean;
  maxLength?: number;
};

/** One explicit request for the current text. Editing or changing accounts
 * retires the request instead of sending the next draft without another tap. */
export function WritingAssistControl(props: Props) {
  const owner = usePrivateSurfaceKey();
  if (props.disabled || !props.text.trim()) return null;
  return <WritingControl key={JSON.stringify([owner, props.context, props.fieldId, props.text])} {...props} />;
}

function WritingControl(props: Props) {
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { setActive(false); setTimedOut(false); }
    });
    return () => subscription.remove();
  }, []);
  const request = () => {
    if (AppState.currentState && AppState.currentState !== 'active') return;
    setTimedOut(false); setAttempt(value => value + 1); setActive(true);
  };
  return (
    <View style={styles.wrap}>
      <Pressable accessibilityRole="button" onPress={request} style={styles.action}>
        <Text style={styles.actionText}>{active || timedOut ? 'Try another draft' : 'Refine with AI'}</Text>
      </Pressable>
      <Text style={styles.help}>Uses only this text. Review the draft before replacing your words.</Text>
      {timedOut && <Text style={styles.help} accessibilityRole="alert">A draft is unavailable right now. Your text has not changed.</Text>}
      {active && <WritingRequest key={attempt} {...props}
        onCancel={() => setActive(false)}
        onTimeout={() => { setActive(false); setTimedOut(true); }}
        onInsert={text => { props.onInsert(text); setActive(false); }} />}
    </View>
  );
}

function WritingRequest({ onCancel, onTimeout, maxLength = 2000, ...props }: Props & {
  onCancel: () => void; onTimeout: () => void;
}) {
  const result = useAiWritingAssist({ context: props.context, fieldId: props.fieldId, text: props.text, optedIn: true });
  const [deadline] = useState(() => Date.now() + 10_000);
  const [scope] = useState(currentDiscoveryScope);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Includes policy acquisition. Parent re-renders cannot extend the budget.
  useEffect(() => {
    if (result.settled) return;
    const timer = setTimeout(onTimeout, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [result.settled, onTimeout, deadline]);
  const proposals = result.proposals.filter(p => p.insertText.length <= maxLength);
  return (
    <>
      <AiWritingAssist proposals={proposals} loading={!result.settled}
        onInsert={proposal => {
          if (mounted.current && isCurrentDiscoveryScope(scope) && (!AppState.currentState || AppState.currentState === 'active')) props.onInsert(proposal.insertText);
        }} />
      {result.settled && proposals.length === 0 && <Text style={styles.help} accessibilityRole="alert">No draft is available. You can keep editing or try again.</Text>}
      <Pressable accessibilityRole="button" onPress={onCancel} style={styles.action}>
        <Text style={styles.actionText}>Dismiss writing help</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  action: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  actionText: { ...(typography.small as object), color: color.signal },
  help: { ...(typography.small as object), color: color.mute },
});
