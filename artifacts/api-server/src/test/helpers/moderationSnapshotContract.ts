/**
 * The moderation subject-snapshot CONTRACT shared with the mobile admin screen.
 *
 * `loadModerationSubjectSnapshots` decides the keys a moderator's client reads
 * (`excerpt` for post/comment/message/review, `displayName` for a buddy
 * listing, …). The mobile "User Reports" screen once read keys the server never
 * sent and its test passed on a hand-written fixture (verifier finding 1,
 * 2026-10-06). So the fixture both sides use is GENERATED from the server
 * readers over these rows and committed at CONTRACT_FIXTURE_PATH:
 * adminModerationReportReview.test.ts fails if the server's output drifts from
 * the committed file, and the mobile test renders every entry of that file.
 */
import { loadModerationSubjectSnapshots, type SubjectSnapshot } from "../../lib/moderationReportSnapshots.js";

export const CONTRACT_FIXTURE_PATH = "travel-buddy-standalone/app/admin/__tests__/fixtures/moderationSubjectSnapshots.json";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** One row per reader, with the text a moderator must be able to see. */
const ROWS: Record<string, Record<string, unknown>[]> = {
  profiles: [{ id: ID(1), name: "Nadia Rahman", handle: "nadia", account_status: "active" }],
  posts: [
    { id: ID(2), author_id: ID(1), content: "the reported post text", created_at: "2026-10-05T10:00:00.000Z", deleted_at: null },
    { id: ID(3), author_id: ID(1), content: "removed before review", created_at: "2026-10-05T10:00:00.000Z", deleted_at: "2026-10-05T11:00:00.000Z" },
  ],
  posts_comments: [{ id: ID(4), post_id: ID(2), user_id: ID(1), body: "the reported comment text", created_at: "2026-10-05T10:00:00.000Z", deleted_at: null }],
  messages: [{ id: ID(5), thread_id: ID(9), sender_id: ID(1), body: "the reported message text", created_at: "2026-10-05T10:00:00.000Z", deleted_at: null }],
  events: [{ id: ID(6), host_id: ID(1), title: "Night market crawl", starts_at: "2026-10-07T18:00:00.000Z", city: "Da Nang", state: "published" }],
  reviews: [{ id: ID(7), reviewer_id: ID(1), entity_type: "buddy", entity_id: ID(8), rating: 1, body: "the reported review text", state: "published" }],
  rent_buddy_profiles: [{ id: ID(8), user_id: ID(1), display_name: "Nadia", tagline: "Local food guide", status: "active" }],
  media_assets: [{ id: ID(10), owner_user_id: ID(1), media_type: "photo", caption: "the reported caption", moderation_status: "approved" }],
  places: [{ id: ID(11), name: "Han Market", address: "119 Tran Phu, Da Nang" }],
};

/** subject_type → the subject id each fixture report names. */
const REPORTS: Array<{ key: string; subject_type: string; subject_id: string | null }> = [
  { key: "user", subject_type: "user", subject_id: ID(1) },
  { key: "post", subject_type: "post", subject_id: ID(2) },
  { key: "post_deleted", subject_type: "post", subject_id: ID(3) },
  { key: "comment", subject_type: "comment", subject_id: ID(4) },
  { key: "message", subject_type: "message", subject_id: ID(5) },
  { key: "event", subject_type: "event", subject_id: ID(6) },
  { key: "review", subject_type: "review", subject_id: ID(7) },
  { key: "buddy_listing", subject_type: "buddy_listing", subject_id: ID(8) },
  { key: "media", subject_type: "media", subject_id: ID(10) },
  { key: "place", subject_type: "place", subject_id: ID(11) },
  { key: "not_found", subject_type: "post", subject_id: ID(99) },
  { key: "unsupported", subject_type: "trip", subject_id: ID(12) },
];

function fakeClient(failing: ReadonlySet<string> = new Set()) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            async in(col: string, ids: string[]) {
              if (failing.has(table)) return { data: null, error: { message: `${table} unavailable`, code: "XX000" } };
              return { data: (ROWS[table] ?? []).filter((r) => ids.includes(String(r[col]))), error: null };
            },
          };
        },
      };
    },
  };
}

export interface ContractEntry {
  subject_type: string;
  subject_snapshot: SubjectSnapshot;
}

/** What the server emits for every fixture report, keyed by fixture name; plus one `unavailable`. */
export async function buildSnapshotContract(): Promise<Record<string, ContractEntry>> {
  const reports = REPORTS.map((r, i) => ({ id: `r${i}`, subject_type: r.subject_type, subject_id: r.subject_id }));
  const { snapshots } = await loadModerationSubjectSnapshots(fakeClient(), reports);
  const out: Record<string, ContractEntry> = {};
  REPORTS.forEach((r, i) => { out[r.key] = { subject_type: r.subject_type, subject_snapshot: snapshots.get(`r${i}`)! }; });
  const failed = await loadModerationSubjectSnapshots(fakeClient(new Set(["messages"])), [{ id: "u", subject_type: "message", subject_id: ID(5) }]);
  out.unavailable = { subject_type: "message", subject_snapshot: failed.snapshots.get("u")! };
  return out;
}

/** The committed file's exact bytes for a contract. */
export function contractFileText(contract: Record<string, ContractEntry>): string {
  return JSON.stringify(contract, null, 2) + "\n";
}
