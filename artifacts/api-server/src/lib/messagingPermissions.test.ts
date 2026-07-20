/**
 * Unit tests for the canMessage permission resolver.
 *
 * Tests run with node:test. The Supabase client is fully faked — no network
 * calls are made.
 *
 * Scenario coverage (8 core scenarios):
 *   1. Cannot message self → denied / reason = 'self'
 *   2. message_privacy = 'no_one' → denied
 *   3. message_privacy = 'everyone' → allowed
 *   4. message_privacy = 'friends', not friends → requires_request
 *   5. message_privacy = 'friends', mutual friends → allowed
 *   6. message_privacy = 'following', not following → requires_request
 *   7. message_privacy = 'following', sender follows recipient → allowed
 *   8. allow_message_requests = false, primary denied → denied
 *
 * Plus: trip/circle override elevates to direct even when primary denies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canMessage } from './messagingPermissions';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

interface FakeState {
  settings?: Record<string, any> | null;
  isFriend?: boolean;
  senderFollowsRecipient?: boolean;
  recipientFollowsSender?: boolean;
  sharedTrip?: boolean;
  sharedCircle?: boolean;
}

function makeFakeClient(state: FakeState) {
  const {
    settings = null,
    isFriend = false,
    senderFollowsRecipient = false,
    recipientFollowsSender = false,
    sharedTrip = false,
    sharedCircle = false,
  } = state;

  function chain(value: any) {
    const obj: any = {
      select: () => obj,
      eq: () => obj,
      or: () => obj,
      limit: () => obj,
      in: () => obj,
      maybeSingle: async () => ({ data: value, error: null }),
    };
    return obj;
  }

  let followCallIndex = 0;

  // Synthetic trip_members rows to model shared trips.
  // If sharedTrip=true, both A and B are members of trip-shared-1.
  const tripRows = sharedTrip
    ? [
        { trip_id: 'trip-shared-1', user_id: A, role: 'member' },
        { trip_id: 'trip-shared-1', user_id: B, role: 'member' },
      ]
    : [];

  function tripChain(initialRows: any[]) {
    let rows = [...initialRows];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { rows = rows.filter((r) => r[col] === val); return b; },
      in: (col: string, vals: any[]) => { rows = rows.filter((r) => vals.includes(r[col])); return b; },
      limit: (n: number) => { rows = rows.slice(0, n); return b; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      or: () => b,
      then: (onF: any, onR: any) => Promise.resolve({ data: rows, error: null }).then(onF, onR),
    };
    return b;
  }

  return {
    from: (table: string) => {
      return {
        select: (_cols: string) => {
          if (table === 'user_message_settings') return chain(settings);
          if (table === 'user_friendships') return chain(isFriend ? { user_a: A } : null);
          if (table === 'user_follows') {
            // First call = sender→recipient, second = recipient→sender
            followCallIndex++;
            if (followCallIndex === 1) return chain(senderFollowsRecipient ? { follower_id: A } : null);
            return chain(recipientFollowsSender ? { follower_id: B } : null);
          }
          if (table === 'trip_members') return tripChain(tripRows);
          if (table === 'circle_memberships') return chain(sharedCircle ? { user_id: B } : null);
          return chain(null);
        },
      };
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Scenario 1: Self → denied
// ---------------------------------------------------------------------------
test('cannot message self', async () => {
  const sc = makeFakeClient({});
  const r = await canMessage(sc, A, A);
  assert.equal(r.verdict, 'denied');
  assert.equal(r.reason, 'self');
  assert.equal(r.allowed, false);
});

// ---------------------------------------------------------------------------
// Scenario 2: message_privacy = 'no_one' → denied
// ---------------------------------------------------------------------------
test('no_one privacy → denied', async () => {
  const sc = makeFakeClient({ settings: { message_privacy: 'no_one', allow_message_requests: true, allow_trip_member_messages: true, allow_circle_member_messages: true } });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'denied');
  assert.equal(r.reason, 'no_one');
});

// ---------------------------------------------------------------------------
// Scenario 3: message_privacy = 'everyone' → allowed
// ---------------------------------------------------------------------------
test('everyone privacy → allowed', async () => {
  const sc = makeFakeClient({ settings: { message_privacy: 'everyone', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false } });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'allowed');
  assert.equal(r.allowed, true);
});

// ---------------------------------------------------------------------------
// Scenario 4: message_privacy = 'friends', not friends → requires_request
// ---------------------------------------------------------------------------
test('friends privacy, not friends, requests allowed → requires_request', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'friends', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
    isFriend: false,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'requires_request');
  assert.equal(r.relationship_context.isFriend, false);
});

// ---------------------------------------------------------------------------
// Scenario 5: message_privacy = 'friends', mutual friends → allowed
// ---------------------------------------------------------------------------
test('friends privacy, is friend → allowed', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'friends', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
    isFriend: true,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'allowed');
  assert.equal(r.relationship_context.isFriend, true);
});

// ---------------------------------------------------------------------------
// Scenario 6: message_privacy = 'following' → recipient accepts messages from people they follow.
//             The recipient does NOT follow the sender → requires_request.
// ---------------------------------------------------------------------------
test('following privacy, sender not following → requires_request', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'following', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
    recipientFollowsSender: false,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'requires_request');
});

// ---------------------------------------------------------------------------
// Scenario 7: message_privacy = 'following' → recipient follows sender → allowed.
// ---------------------------------------------------------------------------
test('following privacy, recipient follows sender → allowed', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'following', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
    recipientFollowsSender: true,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'allowed');
  assert.equal(r.relationship_context.recipientFollowsSender, true);
});

// ---------------------------------------------------------------------------
// Scenario 8: allow_message_requests = false, primary denied → denied
// ---------------------------------------------------------------------------
test('requests disabled, primary denied → denied', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'friends', allow_message_requests: false, allow_trip_member_messages: false, allow_circle_member_messages: false },
    isFriend: false,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'denied');
  assert.equal(r.reason, 'privacy_setting');
});

// ---------------------------------------------------------------------------
// Scenario 9: shared trip override elevates to direct (even if primary denies)
// ---------------------------------------------------------------------------
test('shared trip override with allow_trip_member_messages=true → allowed', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'friends', allow_message_requests: false, allow_trip_member_messages: true, allow_circle_member_messages: false },
    isFriend: false,
    sharedTrip: true,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'allowed');
  assert.equal(r.relationship_context.sharedTrip, true);
});

// ---------------------------------------------------------------------------
// Scenario 10: shared circle override elevates to direct
// ---------------------------------------------------------------------------
test('shared circle override with allow_circle_member_messages=true → allowed', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'friends', allow_message_requests: false, allow_trip_member_messages: false, allow_circle_member_messages: true },
    isFriend: false,
    sharedCircle: true,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'allowed');
  assert.equal(r.relationship_context.sharedCircle, true);
});

// ---------------------------------------------------------------------------
// Scenario 11: no settings row → defaults apply (everyone → allowed)
// ---------------------------------------------------------------------------
test('no settings row → defaults (everyone) → allowed', async () => {
  const sc = makeFakeClient({ settings: null });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'allowed');
});

// ---------------------------------------------------------------------------
// Scenario 12: followers privacy → recipient accepts messages from their followers.
//              Sender follows recipient → allowed.
// ---------------------------------------------------------------------------
test('followers privacy, sender follows recipient → allowed', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'followers', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
    senderFollowsRecipient: true,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'allowed');
  assert.equal(r.relationship_context.senderFollowsRecipient, true);
});

// ---------------------------------------------------------------------------
// Scenario 13: followers privacy, sender does NOT follow recipient → requires_request
// ---------------------------------------------------------------------------
test('followers privacy, sender not following recipient → requires_request', async () => {
  const sc = makeFakeClient({
    settings: { message_privacy: 'followers', allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false },
    senderFollowsRecipient: false,
  });
  const r = await canMessage(sc, A, B);
  assert.equal(r.verdict, 'requires_request');
});
