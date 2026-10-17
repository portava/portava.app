import { createSequenceGuard } from './raceGuard.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';

export interface InputRequest {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export function createInputRequestScheduler() {
  const guard = createSequenceGuard();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  const cancel = () => {
    guard.invalidate();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  const schedule = (run: (request: InputRequest) => void, delayMs: number) => {
    cancel();
    const sequence = guard.next();
    const accountScope = currentDiscoveryScope();
    timer = setTimeout(() => {
      timer = null;
      if (!isCurrentDiscoveryScope(accountScope)) return;
      const currentController = new AbortController();
      controller = currentController;
      run({
        signal: currentController.signal,
        isCurrent: () => guard.isCurrent(sequence) && !currentController.signal.aborted && isCurrentDiscoveryScope(accountScope),
      });
    }, delayMs);
  };

  return { schedule, cancel };
}
