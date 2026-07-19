/**
 * CallRealtimeBinding — routes Telegraph realtime call events into the ONE
 * client call manager (CallContext). Mounted once inside CallProvider in the
 * root layout; renders nothing.
 *
 * - call.incoming  → presentIncomingCall (banner shown by Phase-2 UI)
 * - call.canceled / call.declined / call.missed / call.ended → clear a
 *   matching incoming banner or tear down the matching in-progress call.
 */
import { useEffect, useRef } from 'react';
import { telegraphRealtime, type TelegraphEvent } from '../../services/telegraphRealtimeService.ts';
import { useCallActions, useCallState, type IncomingCallInfo } from '../../context/CallContext.tsx';
import type { CallSessionDto } from '../../services/calls.ts';

export function CallRealtimeBinding() {
  const actions = useCallActions();
  const state = useCallState();

  // Refs so the single subscription always sees current state without resubscribing.
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const unsub = telegraphRealtime.subscribe((evt: TelegraphEvent) => {
      if (!evt.type.startsWith('call.')) return;
      const payload = (evt.payload ?? {}) as {
        callId?: string;
        session?: CallSessionDto;
        caller?: { id: string; name: string | null; avatarUrl: string | null };
      };
      const callId = payload.callId ?? payload.session?.id;
      if (!callId) return;
      const s = stateRef.current;
      const a = actionsRef.current;

      switch (evt.type) {
        case 'call.incoming': {
          const session = payload.session;
          if (!session) return;
          const info: IncomingCallInfo = {
            callId,
            callType: session.callType,
            contextType: session.contextType,
            threadId: session.threadId,
            caller: {
              id: payload.caller?.id ?? session.startedBy,
              name: payload.caller?.name ?? null,
              avatarUrl: payload.caller?.avatarUrl ?? null,
            },
          };
          a.presentIncomingCall(info);
          return;
        }
        case 'call.canceled':
        case 'call.declined':
        case 'call.missed':
        case 'call.ended': {
          // Remote party ended/declined/canceled — dismiss a matching incoming
          // banner, or hang up a matching in-progress call.
          if (s.incoming?.callId === callId) {
            // Incoming banner for a call that no longer rings: hangUp has no
            // session ref here, so it just tears state back to idle.
            void a.hangUp();
            return;
          }
          if (s.session?.id === callId && evt.type !== 'call.missed') {
            void a.hangUp();
          }
          return;
        }
        default:
          return;
      }
    });
    return unsub;
  }, []);

  return null;
}
