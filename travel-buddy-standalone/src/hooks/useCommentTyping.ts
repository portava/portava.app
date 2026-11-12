import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useInputAccountEpoch } from '../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { useSession } from '../context/SessionContext.tsx';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { readCommentTyping, sendCommentTyping } from '../services/commentTyping.ts';

/** Only a boolean leaves the device; idle, closed and background composers stop announcing. */
export function useCommentTyping(postId: string, active: boolean, text: string): number {
  const { userId } = useSession();
  const epoch = useInputAccountEpoch();
  const scope = useMemo(() => ({ postId, active, userId, epoch, owner: captureMessagingOwnerRequest() }), [postId, active, userId, epoch]);
  const [snapshot, setSnapshot] = useState({ scope, count: 0 });
  const edit = useRef({ text, at: 0 });
  const context = useRef({ postId, active, userId });
  useLayoutEffect(() => { context.current = { postId, active, userId }; }, [postId, active, userId]);
  const pulse = useRef<() => void>(() => {});
  useEffect(() => {
    if (edit.current.text !== text) { edit.current = { text, at: Date.now() }; pulse.current(); }
  }, [text]);
  useEffect(() => {
    const setCount = (count: number) => setSnapshot({ scope, count });
    setCount(0);
    if (!active || !userId) return;
    const owner = scope.owner;
    if (!owner) return;
    let live = true;
    let backgroundRevision = 0;
    let foreground = AppState.currentState !== 'inactive' && AppState.currentState !== 'background';
    let lastSent = 0;
    let announced = false;
    let reading = false;
    let sending = false;
    let write: Promise<void> = Promise.resolve();
    const valid = () => live && owner.isCurrent() && context.current.active && context.current.postId === postId && context.current.userId === userId;
    const tick = async (readPresence = true) => {
      if (!valid() || !foreground) { if (live) setCount(0); return; }
      const typing = edit.current.text.trim().length > 0 && Date.now() - edit.current.at < 3000;
      if (!sending && (typing !== announced || typing && Date.now() - lastSent >= 2500)) {
        sending = true; announced = typing; lastSent = Date.now();
        write = sendCommentTyping(postId, typing, { owner, isCurrent: () => valid() && foreground }).finally(() => { sending = false; });
      }
      if (!readPresence || reading) return;
      reading = true;
      try { const value = await readCommentTyping(postId, { owner, isCurrent: () => valid() && foreground }); if (valid() && foreground) setCount(value); }
      finally { reading = false; }
    };
    const stop = () => {
      if (live) setCount(0);
      const revision = backgroundRevision;
      if (announced && owner.isCurrent()) void write.then(() => {
        if (owner.isCurrent() && (!live || revision === backgroundRevision && !foreground)) return sendCommentTyping(postId, false, { owner });
      });
      announced = false;
    };
    pulse.current = () => { void tick(false); };
    void tick();
    const timer = setInterval(() => { void tick(); }, 2000);
    const app = AppState.addEventListener('change', state => { backgroundRevision++; foreground = state === 'active'; if (foreground) void tick(); else stop(); });
    return () => { live = false; clearInterval(timer); app.remove(); pulse.current = () => {}; stop(); };
  }, [scope, postId, active, userId]);
  return active && scope.owner?.isCurrent() && snapshot.scope === scope ? snapshot.count : 0;
}
