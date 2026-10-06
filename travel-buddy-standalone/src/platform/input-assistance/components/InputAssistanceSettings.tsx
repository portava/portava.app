/**
 * The Input Intelligence opt-ins as one Settings block: OD-INPUT-1's outcome
 * learning and OD-INPUT-3's Compass memory.
 *
 * RENDERED FOR EVERY SIGNED-IN PERSON, NOT BEHIND THE CLIENT'S FLAG MAP. A
 * person who opted in must always be able to see that and withdraw — including
 * after the owner turns a flag off (the server stops using the data at once, but
 * the record of the choice remains theirs), and when the client's fail-soft flag
 * fetch has left its map empty. Each row asks the SERVER whether it is offered
 * or on for this person, and hides itself only when it is neither.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { space } from '../../../theme/tokens.ts';
import { OutcomeLearningSetting, type OutcomeLearningSettingProps } from './OutcomeLearningSetting.tsx';
import { MemoryContextSetting, type MemoryContextSettingProps } from './MemoryContextSetting.tsx';

export interface InputAssistanceSettingsProps {
  outcome?: OutcomeLearningSettingProps;
  memory?: MemoryContextSettingProps;
}

export function InputAssistanceSettings({ outcome, memory }: InputAssistanceSettingsProps) {
  return (
    <View style={styles.block} testID="input-assistance-settings">
      <OutcomeLearningSetting {...outcome} />
      <MemoryContextSetting {...memory} />
    </View>
  );
}

const styles = StyleSheet.create({ block: { gap: space.sm } });
