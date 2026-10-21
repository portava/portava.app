/**
 * The two chat screens' WIRING to read state and to their own thread controls —
 * held at the source level, because neither screen mounts under jest-expo
 * (app/messages/[id].tsx: see unsupportedPayload.component.test.tsx; the trip
 * chat has never had a component test). The BEHAVIOUR is pinned where it lives:
 * useThreadReadState.component.test.ts, readState.component.test.ts,
 * ownMessageStatusRow.component.test.tsx and TelegraphInboxBlockHonesty. This
 * file pins that the screens actually use it, and that the shapes that were
 * wrong cannot come back unnoticed.
 *
 * Every assertion here was RED on the tree before this change (TELEGRAPH lane,
 * 2026-10-03): the screens read `last_read_at` themselves, the thread screen
 * stamped "read" on mount, the trip chat never marked anything read and muted
 * the TRIP id, and five thread controls acted on a result they never looked at.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../../..');
const dm = readFileSync(join(root, 'app/messages/[id].tsx'), 'utf8');
const group = readFileSync(join(root, 'src/components/GroupChatScreen.tsx'), 'utf8');

describe('read state — both screens use the shared hook, and read nothing themselves', () => {
  it.each([['thread screen', dm], ['trip/circle chat', group]])('%s calls useThreadReadState and draws OwnMessageStatusRow', (_n, src) => {
    expect(src).toMatch(/useThreadReadState\(\{ threadId: /);
    expect(src).toMatch(/<OwnMessageStatusRow status=\{receiptState\}/);
  });

  it.each([['thread screen', dm], ['trip/circle chat', group]])('%s no longer reads last_read_at straight from message_thread_members', (_n, src) => {
    expect(src).not.toMatch(/\.select\('(user_id, )?last_read_at'\)/);
  });

  it('the thread screen no longer stamps "read" on mount', () => {
    expect(dm).not.toMatch(/markThreadRead\(/);
  });

  it('the trip chat passes the shared status, not a locally derived receipt', () => {
    expect(group).toMatch(/receiptState=\{mine \? readState\.statusFor\(m\) : null\}/);
    expect(group).not.toMatch(/deriveReceiptState\(/);
  });
});

describe('thread controls — each acts on what the server answered', () => {
  it('the trip chat mutes the THREAD, not the trip or circle id it was opened with', () => {
    expect(group).not.toMatch(/muteThread\(id, next\)/);
    expect(group).toMatch(/const tid = thread\?\.id;[\s\S]{0,200}muteThread\(tid, next\)/);
  });

  it('every mute toggle flips only on success, and says so on failure', () => {
    for (const src of [dm, group]) {
      expect(src).not.toMatch(/await muteThread\([^)]*\);\s*setThread(Is)?Muted\(next\);/);
    }
    expect((dm.match(/if \(r\.ok\) setThreadIsMuted\(next\); else Alert\.alert\(/g) ?? []).length).toBe(2);
    expect(group).toMatch(/if \(res\.ok\) setThreadMuted\(next\); else Alert\.alert\(/);
  });

  it('leaving (and deleting for me) navigates away only once the server let you go', () => {
    expect(dm).not.toMatch(/await leaveThread\(id \?\? ''\);\s*router\.replace\('\/messages'\);/);
    expect((dm.match(/if \(left\.ok\) router\.replace\('\/messages'\); else Alert\.alert\(/g) ?? []).length).toBe(2);
  });

  it('a conversation report says whether it was filed', () => {
    expect(dm).not.toMatch(/onReport=\{async \(reason: string\) => \{\s*await reportThread\(id \?\? '', reason\);\s*\}\}/);
    expect(dm).toMatch(/const r = await reportThread\(id \?\? '', reason\); Alert\.alert\(r\.ok \? 'Report submitted' : 'Report not sent'/);
  });

  it('the thread screen starts from the mute state the inbox read from the server', () => {
    expect(dm).toMatch(/useState\(muted === '1'\)/);
  });
});

// ── census-telegraph T320: "Buddy booking cancelled → booking-only actions disabled immediately" ──
//
// The booking thread read the booking ONCE, on mount: the call buttons (gated on its status) and
// the booking header's Safety / Add Time stayed up after a cancellation until the screen was left
// and reopened. Every status transition writes a booking card into this very thread
// (routes/rentABuddy.ts emitBookingCard, including "cancelled"), so the open thread hears it: the
// newest booking transition is a key the booking read, the header and the rail depend on.
describe('T320 — the open booking thread re-reads the booking when its transition card arrives', () => {
  // Loaded per call, so a tree without the module fails case by case rather than starving the file.
  const key = (msgs: Array<Record<string, unknown>>) => {
    let mod: any = {};
    try { mod = require('../booking/bookingTransition.ts'); } catch { /* absent: the call below fails the case */ }
    return mod.latestBookingTransitionKey(msgs);
  };

  it('the key is the NEWEST booking transition — a booking card or a Rent-a-Buddy milestone — and nothing else', () => {
    expect(key([])).toBeNull();
    expect(key([{ id: 'a', msgType: 'text' }, { id: 'b', msgType: 'system', subtype: 'call_missed' }])).toBeNull();
    expect(key([
      { id: 'c1', msgType: 'booking_card', subtype: 'booking_status_confirmed' },
      { id: 't', msgType: 'text' },
      { id: 'c2', msgType: 'booking_card', subtype: 'booking_status_cancelled' },
      { id: 't2', msgType: 'text' },
    ])).toBe('c2');
    expect(key([{ id: 'c1', msgType: 'booking_card' }, { id: 'm1', msgType: 'system', subtype: 'rent_buddy_extra_time' }])).toBe('m1');
  });

  it('the booking read, the booking header and the rail all depend on it', () => {
    expect(dm).toContain('const bookingTransitionKey = latestBookingTransitionKey(messages);');
    expect(dm).toContain('}, [threadType, contextId, bookingTransitionKey]);');
    expect(dm).toMatch(/<RentABuddyThreadHeader\s+key=\{bookingTransitionKey \?\? 'booking'\}/);
    expect(dm).toContain("<SharedContextRail threadId={id} key={bookingTransitionKey ?? 'rail'} scrolled={railCollapsed} />");
  });
});
