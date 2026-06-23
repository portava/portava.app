import { test } from "node:test";
import assert from "node:assert/strict";
import {
  subscribe,
  publishToUsers,
  publishToThread,
  isUserConnected,
  connectedUserCount,
  type TelegraphEvent,
} from "../lib/telegraphEvents.js";

test("subscribe delivers events to the right user and unsubscribe stops them", () => {
  const received: TelegraphEvent[] = [];
  const unsub = subscribe("user-a", (e) => received.push(e));

  assert.equal(isUserConnected("user-a"), true);
  assert.equal(isUserConnected("user-b"), false);

  publishToUsers(["user-a"], { type: "message.created", payload: { messageId: "m1" } });
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "message.created");
  assert.ok(received[0].ts, "event has a timestamp");

  // Event for a different user is not delivered.
  publishToUsers(["user-b"], { type: "message.created", payload: { messageId: "m2" } });
  assert.equal(received.length, 1);

  unsub();
  assert.equal(isUserConnected("user-a"), false);
  publishToUsers(["user-a"], { type: "message.created", payload: { messageId: "m3" } });
  assert.equal(received.length, 1, "no delivery after unsubscribe");
});

test("publishToUsers de-duplicates repeated ids", () => {
  const received: TelegraphEvent[] = [];
  const unsub = subscribe("dedupe-user", (e) => received.push(e));
  publishToUsers(["dedupe-user", "dedupe-user", "dedupe-user"], { type: "read.updated" });
  assert.equal(received.length, 1);
  unsub();
});

test("a throwing subscriber is isolated and does not block others", () => {
  const good: TelegraphEvent[] = [];
  const unsub1 = subscribe("multi", () => {
    throw new Error("boom");
  });
  const unsub2 = subscribe("multi", (e) => good.push(e));
  publishToUsers(["multi"], { type: "thread.updated" });
  assert.equal(good.length, 1, "second subscriber still received the event");
  unsub1();
  unsub2();
});

test("multiple connections for one user all receive the event", () => {
  let a = 0;
  let b = 0;
  const u1 = subscribe("dual", () => { a++; });
  const u2 = subscribe("dual", () => { b++; });
  assert.equal(connectedUserCount() >= 1, true);
  publishToUsers(["dual"], { type: "typing.started" });
  assert.equal(a, 1);
  assert.equal(b, 1);
  u1();
  u2();
});

test("publishToThread resolves active members and excludes the actor", async () => {
  // Fake supabase client returning two active members for the thread.
  const fakeClient: any = {
    from() {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        is() { return builder; },
        then(onF: any, onR: any) {
          return Promise.resolve({
            data: [{ user_id: "actor" }, { user_id: "other-1" }, { user_id: "other-2" }],
            error: null,
          }).then(onF, onR);
        },
      };
      return builder;
    },
  };

  const actorEvents: TelegraphEvent[] = [];
  const other1Events: TelegraphEvent[] = [];
  const ua = subscribe("actor", (e) => actorEvents.push(e));
  const uo = subscribe("other-1", (e) => other1Events.push(e));

  await publishToThread(
    fakeClient,
    "thread-1",
    { type: "message.created", payload: { messageId: "m9" } },
    { excludeUserId: "actor" },
  );

  assert.equal(actorEvents.length, 0, "actor is excluded");
  assert.equal(other1Events.length, 1, "other member received it");
  assert.equal(other1Events[0].threadId, "thread-1");

  ua();
  uo();
});

test("publishToThread swallows resolver errors", async () => {
  const failingClient: any = {
    from() {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        is() { return builder; },
        then(_onF: any, onR: any) {
          return Promise.reject(new Error("db down")).then(_onF, onR);
        },
      };
      return builder;
    },
  };

  // Should not throw.
  await publishToThread(failingClient, "thread-x", { type: "thread.updated" });
  assert.ok(true);
});
