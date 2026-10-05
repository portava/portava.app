/**
 * Telegraph §24 / census T295 — the thread screen asks the server what it may
 * offer, instead of reading `message_thread_members` and `message_threads`.
 *
 * Pins (1) how the server's answer folds into what the screen offers, with every
 * "not known" reading on the side that offers less, and (2) that the screen is
 * wired to it — at source level, because `app/messages/[id].tsx` does not mount
 * under jest-expo (see unsupportedPayload.component.test.tsx).
 *
 * SHOWN RED (T2 lane report): `treatAsE2eeForEdit` returning `state.isE2ee === true`
 * (unknown read as "not encrypted") turns the edit-affordance case red; putting
 * the member-count read of the raw roster table back turns the wiring
 * case red.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  memberCountOf,
  offersPlanControl,
  showsE2eeBadge,
  toProjectionState,
  treatAsE2eeForEdit,
  type ConversationProjectionWire,
} from '../conversation/conversationProjection.ts';

function wire(over: Partial<ConversationProjectionWire> = {}): ConversationProjectionWire {
  return {
    conversationId: 't1',
    conversationType: 'circle',
    capabilities: { canSendMessage: true },
    reasons: { canSendMessage: null },
    degraded: false,
    conversation: { memberCount: 4, isE2ee: false, degraded: false },
    ...over,
  };
}

describe('toProjectionState — the server answer, folded', () => {
  it('a healthy member answer offers the plan control and carries the measured facts', () => {
    const s = toProjectionState(wire());
    expect(offersPlanControl(s)).toBe(true);
    expect(memberCountOf(s)).toBe(4);
    expect(showsE2eeBadge(s)).toBe(false);
    expect(treatAsE2eeForEdit(s)).toBe(false);
  });

  it('an encrypted thread draws the badge and withholds the edit affordance', () => {
    const s = toProjectionState(wire({ conversation: { memberCount: 2, isE2ee: true, degraded: false } }));
    expect(showsE2eeBadge(s)).toBe(true);
    expect(treatAsE2eeForEdit(s)).toBe(true);
  });

  it('a non-member (every capability false, facts null) is offered nothing and shown no count', () => {
    const s = toProjectionState(wire({
      capabilities: { canSendMessage: false },
      conversation: { memberCount: null, isE2ee: null, degraded: false },
    }));
    expect(offersPlanControl(s)).toBe(false);
    expect(memberCountOf(s)).toBeNull();
  });
});

describe('every "not known" offers less', () => {
  it('loading and a failed read offer no plan control, no badge, no edit, no count', () => {
    for (const s of [{ status: 'loading' as const }, toProjectionState(null)]) {
      expect(offersPlanControl(s)).toBe(false);
      expect(showsE2eeBadge(s)).toBe(false);
      expect(treatAsE2eeForEdit(s)).toBe(true);
      expect(memberCountOf(s)).toBeNull();
    }
  });

  it('a DEGRADED capability answer does not offer the plan control on a guess', () => {
    expect(offersPlanControl(toProjectionState(wire({ degraded: true })))).toBe(false);
  });

  it('an unknown encryption state is treated as encrypted for edit, and draws no badge', () => {
    const s = toProjectionState(wire({ conversation: { memberCount: 3, isE2ee: null, degraded: true } }));
    expect(treatAsE2eeForEdit(s)).toBe(true);
    expect(showsE2eeBadge(s)).toBe(false);
  });

  it('an older server with no conversation block yields nulls, not zeros', () => {
    const s = toProjectionState(wire({ conversation: undefined }));
    expect(memberCountOf(s)).toBeNull();
    expect(treatAsE2eeForEdit(s)).toBe(true);
  });
});

describe('the thread screen is wired to the projection and reads no raw messaging table', () => {
  const src = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');

  it('mounts useConversationProjection and derives the three affordances from it', () => {
    expect(src).toMatch(/useConversationProjection\(id \?\? null\)/);
    expect(src).toMatch(/const isAcceptedMember = offersPlanControl\(conversationProjection\)/);
    expect(src).toMatch(/const memberCount = memberCountOf\(conversationProjection\)/);
    expect(src).toMatch(/showsE2eeBadge\(conversationProjection\)/);
    expect(src).toMatch(/treatAsE2eeForEdit\(conversationProjection\)/);
  });

  it('has no .from() read of message_thread_members or message_threads', () => {
    expect(src).not.toMatch(/\.from\(\s*['"]message_thread_members['"]/);
    expect(src).not.toMatch(/\.from\(\s*['"]message_threads['"]/);
  });
});
