/**
 * The long-press sheet's delete row says what the server does.
 *
 * THE DEFECT. The sheet in `app/messages/[id].tsx` offered "Delete for me" and
 * confirmed with "Remove this message for you? Others will still see it." The
 * row then called `deleteMessage(id)` -> `DELETE /api/messages/:id`, and that
 * route (artifacts/api-server/src/routes/groupChat.ts) redacts the SHARED row —
 * `deleted_at = now, body = ''` — and publishes `message.deleted` to every
 * other member. There is no per-user hide anywhere on the server. A traveller
 * who meant to tidy their own view deleted the message for everyone, having
 * been told the opposite. The handler also ignored the result, so a refused
 * delete closed the sheet as if it had worked.
 *
 * WHY SOURCE-LEVEL. The screen does not mount under jest-expo (see
 * unsupportedPayload.component.test.tsx), and the sheet is private to it; this
 * is the same reason threadScreenWiring.component.test.ts holds the screen's
 * wiring at the source level. The SERVER half — that the delete is shared — is
 * read from the route itself below, so the copy is pinned to the contract it
 * describes rather than to a sentence.
 *
 * RED on the tree before this change: 4 failed / 1 passed — the row read
 * "Delete for me", the confirmation promised "Others will still see it", the
 * guard was `mine` alone, and the handler awaited the delete and dropped it.
 * The one green `it` is the server-contract read, which is green on both.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../../..');
const dm = readFileSync(join(root, 'app/messages/[id].tsx'), 'utf8');
const server = readFileSync(join(root, '../artifacts/api-server/src/routes/groupChat.ts'), 'utf8');

/** The delete row of the long-press sheet: from its guard to its closing `)}`. */
function deleteRow(): string {
  const start = dm.indexOf('<Trash2 size={18} color="#EF4444" />');
  expect(start).toBeGreaterThan(0); // vacuity: the row exists
  const open = dm.lastIndexOf('{mine', start);
  const close = dm.indexOf(')}', start);
  return dm.slice(open, close);
}

describe('the server deletes for everyone (the contract the copy must match)', () => {
  it('DELETE /messages/:messageId redacts the shared row and tells every other member', () => {
    const route = server.slice(server.indexOf("router.delete('/messages/:messageId'"));
    expect(route.length).toBeGreaterThan(0);
    expect(route).toMatch(/\.update\(\{ deleted_at: now, body: '' \}\)\s*\n\s*\.eq\('id', messageId\)/);
    expect(route).toMatch(/type: 'message\.deleted'/);
  });
});

describe('the long-press sheet', () => {
  it('no longer promises a delete that only the sender sees', () => {
    expect(dm).not.toMatch(/Others will still see it/);
    expect(dm).not.toMatch(/>Delete for me</);
  });

  it('names the delete for what it is, in the row and in the confirmation', () => {
    const row = deleteRow();
    expect(row).toMatch(/>Delete for everyone</);
    expect(row).toMatch(/Alert\.alert\('Delete for everyone', 'Delete this message for everyone in this conversation\?/);
    expect(row).toMatch(/testID="telegraph-delete-for-everyone"/);
  });

  it('is offered under the same sender-only guard as Unsend', () => {
    expect(deleteRow()).toMatch(/^\{mine && threadId && \(/);
  });

  it('a refused delete is said, not closed in silence', () => {
    const handler = dm.slice(dm.indexOf('const handleDeleteForMe = useCallback'), dm.indexOf('}, [reload]);', dm.indexOf('const handleDeleteForMe')));
    expect(handler).toMatch(/const deleted = await deleteMessage\(msgId\); if \(!deleted\.ok\) Alert\.alert\('Not deleted'/);
  });
});
