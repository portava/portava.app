/**
 * gemApprovalNotifier — a gem's submitter is told when their gem is approved.
 *
 * The submit screen promises "Once approved it'll appear for the community",
 * and `hidden_gems.place_approved` had a template but no producer, so the
 * submitter was never told. Pins:
 *   G1  the submitter gets the notification, naming the gem, opening its page;
 *   G2  without a name it still reads, and still opens the gem;
 *   G3  a second approval of the same gem inside the dedup window is not a
 *       second notification.
 * The route side (only pending -> approved notifies) is pinned in
 * hiddenGems.test.ts, "approving a pending gem tells its submitter".
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/gemApprovalNotification.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFakeClient } from "./telegraphCertificationHarness.js";
import { notifyGemApproved } from "../services/notifications/gemApprovalNotifier.js";
import { renderTemplate } from "../services/notifications/NotificationTemplateService.js";

const SUBMITTER = "a0000000-0000-4000-8000-000000000001";
const GEM = "b0000000-0000-4000-8000-000000000002";

function db(extra: Record<string, any[]> = {}) {
  return makeFakeClient({
    profiles: [{ id: SUBMITTER, handle: "sam_1a2b", username: "sam" }],
    notifications: [],
    ...extra,
  });
}
const rows = (sc: ReturnType<typeof db>) => sc._store.notifications as Array<Record<string, any>>;

describe("gem approval notification", () => {
  it("G1: the submitter is told, with the gem's name, and the tap opens the gem", async () => {
    const sc = db();
    assert.equal(await notifyGemApproved(sc as any, SUBMITTER, GEM, "Rooftop Garden"), true);
    const [n] = rows(sc);
    assert.equal(n.user_id, SUBMITTER);
    assert.equal(n.event_type, "hidden_gems.place_approved");
    assert.equal(n.title, "Place approved!");
    assert.equal(n.body, "Rooftop Garden is now visible to the community");
    assert.equal(n.action_url, `/gems/${GEM}`);
  });

  it("G2: without a name it still reads, and still opens the gem", async () => {
    const sc = db();
    assert.equal(await notifyGemApproved(sc as any, SUBMITTER, GEM, null), true);
    const [n] = rows(sc);
    assert.equal(n.body, "Your submission is now visible to the community");
    assert.equal(n.action_url, `/gems/${GEM}`);
    // An old row with no gem id falls back to the gems list, not nowhere.
    assert.equal(renderTemplate("hidden_gems.place_approved", {})?.actionUrl, "/gems");
  });

  it("G3: approving the same gem again inside the dedup window is not a second notice", async () => {
    const sc = db({
      notifications: [{
        id: "n1", user_id: SUBMITTER, category: "hidden_gems", event_type: "hidden_gems.place_approved",
        source_type: "hidden_gems", source_id: GEM, created_at: new Date(Date.now() - 60_000).toISOString(),
      }],
    });
    assert.equal(await notifyGemApproved(sc as any, SUBMITTER, GEM, "Rooftop Garden"), false);
    assert.equal(rows(sc).length, 1);
  });
});
