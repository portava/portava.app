import { useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { AppState } from 'react-native';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { deliverComposerOutcome } from '../services/composerOutcomeDelivery.ts';
import { newClientEventId } from '../services/clientEventId.ts';
import { isComposerOutcomeEvent, type ComposerOutcome, type ComposerSurface, type ComposerFailureCode, type ComposerOutcomeEvent } from '../services/composerOutcome.ts';
export function useComposerOutcome(surface: ComposerSurface) {
    const { isEnabled } = useFeatureFlags();
    const enabled = isEnabled('MEDIA_ANALYTICS_ENABLED');
    const allowed = useRef(enabled);
    const [owner] = useState(captureMessagingOwnerRequest);
    useLayoutEffect(() => { allowed.current = enabled; }, [enabled]);
    const flush = useCallback((event?: ComposerOutcomeEvent) => deliverComposerOutcome(owner, () => allowed.current, event), [owner]);
    const record = useCallback((outcome: ComposerOutcome, failureCode?: ComposerFailureCode, eventId = newClientEventId()) => {
        const event: ComposerOutcomeEvent = { event_id: eventId, version: 1, surface, outcome, ...(failureCode ? { failure_code: failureCode } : {}) };
        if (allowed.current && isComposerOutcomeEvent(event))
            void flush(event);
        return eventId;
    }, [surface, flush]);
    useEffect(() => { void flush(); }, [enabled, flush]);
    useEffect(() => {
        const sub = AppState.addEventListener('change', state => { if (state === 'active')
            void flush(); });
        return () => sub.remove();
    }, [flush]);
    return record;
}
