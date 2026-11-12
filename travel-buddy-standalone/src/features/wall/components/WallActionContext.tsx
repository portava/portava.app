import React, { createContext, useContext, useMemo, useRef, useEffect } from 'react';
import type { PlanPickerSource } from '../../../components/PlanPickerController.tsx';
import { useInputAccountEpoch } from '../../../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';

export interface WallActionOptions {
  openPlanPicker?: (source: PlanPickerSource) => void;
  isCurrent?: () => boolean;
}
export const WallActionContext = createContext<WallActionOptions>({});

/** Bind every asynchronous card action to the mounted card and signed-in scope. */
export function useWallActionOptions(): WallActionOptions {
  const actions = useContext(WallActionContext);
  const epoch = useInputAccountEpoch();
  const context = useMemo(() => ({ active: true, scope: currentDiscoveryScope() }), [epoch]);
  const current = useRef(context);
  current.current = context;
  useEffect(() => { context.active = true; return () => { context.active = false; }; }, [context]);
  return useMemo(() => ({ ...actions, isCurrent: () => context.active && current.current === context && isCurrentDiscoveryScope(context.scope) }), [actions, context]);
}
