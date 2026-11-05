import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RecapCurationScreen } from '../../src/features/telegraph/memory/RecapCurationScreen';
export default function RecapCurationRoute() {
  const params = useLocalSearchParams<{ threadId?: string; planId?: string; mode?: string }>();
  return <RecapCurationScreen threadId={typeof params.threadId === 'string' ? params.threadId : ''}
    planId={typeof params.planId === 'string' ? params.planId : null}
    mode={params.mode === 'photos' || params.mode === 'people' ? params.mode : 'memory'} />;
}
