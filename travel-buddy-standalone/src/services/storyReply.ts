/**
 * sendStoryReply — a story reply that reaches the author (PLAT-F33).
 *
 * `POST /stories/:id/reply` writes `story_replies`, and nothing in the product
 * reads that table, so a reply sent through it alone was never seen. The flow
 * says a reply goes to the DM, and the DM is where the author reads.
 *
 * ORDER, AND WHY.
 *   1. The story route first. It is the gate: it re-checks, at send time, that
 *      the story is still active and still visible to the replier (block,
 *      audience, expiry). A story the replier can no longer see stops HERE,
 *      before anything reaches a chat.
 *   2. `openDirectThread(author)` — the one funnel every 1:1 entry point goes
 *      through, so the DM permission rules and new-thread E2EE negotiation
 *      apply exactly as they do everywhere else.
 *   3. The text goes through `sendMessage`, the ordinary send path (moderation,
 *      translation, realtime). On an E2EE thread the server refuses a plaintext
 *      body and stores none; the reply is then resent ENCRYPTED. The reverse —
 *      retrying an encrypted send as plaintext — never happens.
 *
 * No server-side DM write was added: a second write path into threads would
 * skip the message-request and E2EE rules the send route already owns.
 */
import { replyToStory } from './stories.ts';
import { openDirectThread, sendMessage } from './messaging.ts';

export type StoryReplyResult = { ok: true; threadId: string } | { ok: false; message: string };

const REPLY_MAX = 1000;

export async function sendStoryReply(input: { storyId: string; ownerId: string; text: string }): Promise<StoryReplyResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, message: 'Write a reply first.' };
  if (text.length > REPLY_MAX) return { ok: false, message: `Replies can be up to ${REPLY_MAX} characters.` };

  const gated = await replyToStory(input.storyId, text);
  if (!gated.ok) return { ok: false, message: 'This story is no longer available to reply to.' };

  const thread = await openDirectThread(input.ownerId);
  if (!thread.ok || !thread.data?.threadId) {
    return { ok: false, message: (!thread.ok && thread.message) || 'Could not open a chat with this person. Please try again.' };
  }
  const threadId = thread.data.threadId;
  const body = `Replied to your story: ${text}`;

  try {
    const plain = await sendMessage(threadId, body);
    if (plain.ok) return { ok: true, threadId };
    if (plain.errorKind !== 'invalid_payload') {
      return { ok: false, message: plain.message || 'Your reply could not be sent. Please try again.' };
    }
    // The thread is end-to-end encrypted: the server refused the plaintext and
    // stored none. Send it the way that thread requires.
    const sealed = await sendMessage(threadId, body, { isE2ee: true });
    if (sealed.ok) return { ok: true, threadId };
    return { ok: false, message: sealed.message || 'Your reply could not be sent. Please try again.' };
  } catch {
    return { ok: false, message: 'Your reply could not be sent securely to this chat. Open the chat and try again.' };
  }
}
