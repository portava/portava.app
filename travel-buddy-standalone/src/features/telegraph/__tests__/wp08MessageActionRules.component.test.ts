/**
 * WP-08 / TEL-F07 — when Edit and Edit history are OFFERED.
 *
 * Affordance, not authorization (the server re-checks every edit). The rule
 * that matters most is the E2EE one: the server refuses an edit on an
 * encrypted thread because it would put plaintext on the server, and the menu
 * must not offer what the server will refuse.
 */
import { canEditMessage, canViewEditHistory, editErrorCopy } from '../messageActions/messageActionRules.ts';

const base = { body: 'meet at 7', deleted: false, msgType: 'text', subtype: null } as const;

describe('canEditMessage', () => {
  it('offers Edit on your own delivered plain-text message', () => {
    expect(canEditMessage({ ...base }, true, false)).toBe(true);
  });
  it('never on an end-to-end encrypted thread', () => {
    expect(canEditMessage({ ...base }, true, true)).toBe(false);
  });
  it('never on someone else’s message', () => {
    expect(canEditMessage({ ...base }, false, false)).toBe(false);
  });
  it('not on deleted, media, ciphertext, structured or still-sending messages', () => {
    expect(canEditMessage({ ...base, deleted: true }, true, false)).toBe(false);
    expect(canEditMessage({ ...base, mediaUrl: 'post-media/x.jpg' }, true, false)).toBe(false);
    expect(canEditMessage({ ...base, ciphertext: 'AAAA' }, true, false)).toBe(false);
    expect(canEditMessage({ ...base, msgType: 'system' }, true, false)).toBe(false);
    expect(canEditMessage({ ...base, subtype: 'meetup' }, true, false)).toBe(false);
    expect(canEditMessage({ ...base, body: '{"v":1,"kind":"PLACE_CARD"}' }, true, false)).toBe(false);
    expect(canEditMessage({ ...base, deliveryStatus: 'sending' }, true, false)).toBe(false);
    expect(canEditMessage({ ...base, body: '   ' }, true, false)).toBe(false);
  });
});

describe('canViewEditHistory', () => {
  it('only for a visible message the server marked edited', () => {
    expect(canViewEditHistory({ editedAt: '2026-09-29T10:00:00Z', deleted: false })).toBe(true);
    expect(canViewEditHistory({ editedAt: null, deleted: false })).toBe(false);
    expect(canViewEditHistory({ editedAt: '2026-09-29T10:00:00Z', deleted: true })).toBe(false);
  });
});

describe('editErrorCopy', () => {
  it('names the E2EE refusal, and never says a failed edit was saved', () => {
    expect(editErrorCopy('e2ee_thread', undefined)).toMatch(/end-to-end encrypted/);
    expect(editErrorCopy('degraded_unavailable', undefined)).toMatch(/unchanged/);
    expect(editErrorCopy('something_new', undefined)).toMatch(/not saved/);
  });
});
