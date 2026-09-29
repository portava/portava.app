# Testing-mode flows no census covers

Testing mode (2026-09-28): every intended feature has to work end to end in the hosted testing app. Most flows are recorded in the census that owns their area. This file holds the flows that belong to **no** census, so their build record is not lost. Each section says:

- what was built;
- which tests pin it;
- what a tester does;
- what is still open.

## Stories: react, reply, save to a highlight (PLAT-F33, lane tm-memories, 2026-09-29)

**Why here.** No `docs/architecture/census-*.md` grades stories. `census-highlights-memories.md` touches the stories domain only where a story becomes a Highlight. It records that note under its own testing-mode section, which points back here.

### What was wrong

- **Nothing mounted the story UI.** `StoriesStrip`, `StoryViewer` and `StoryComposer` existed, but nothing under `app/` mounted any of them. So no story could be opened, reacted to, replied to or saved. The Create hub listed "Story" as *Soon*.
- **The owner could not open their own stories.** `GET /stories/feed` never includes the viewer's own stories, and `GET /stories/archive` lists only expired and saved ones. So "save your own story to a highlight" (owner-only) was unreachable.
- **Replies reached nobody.** `POST /stories/:id/reply` writes `story_replies`, and nothing reads that table.
- **Save-to-highlight lost its answer.** `saveToHighlight(storyId, highlightId)` sent an id the route ignores, since the route *creates* a Highlight. It also answered `{ok}` only, which threw away the 409 that explains why a close-friends story cannot become a Highlight.
- **A failed viewer-list read looked empty.** The viewer list showed "No viewers yet" when the read had failed.

### What was built

- **Server: `GET /me/stories`** (`artifacts/api-server/src/routes/stories.ts`, at the foot).
  - It lists the caller's own live stories: state `active`, not expired, oldest first.
  - It takes no user id, so it can only ever be the caller's own.
  - An unreadable table is a 503, and `stories_enabled` off is `feature_disabled`, as on the feed.
- **Client: `/stories`** (`travel-buddy-standalone/app/stories.tsx`, registered in `src/navigation/portavaRoutes.ts`; the Create hub's Story entry now routes there).
  - "Your story" opens your live stories in the viewer, where Save to highlight is. With none, it opens the composer.
  - Below it are the people whose stories the feed says you may see.
  - An unreadable feed is an error with a retry, and stories switched off says so.
- **`StoryViewer`** (`src/components/StoryViewer.tsx`):
  - someone else's story: five quick reactions (`POST /stories/:id/react`) and a reply box;
  - your own story: Viewers, plus Save to highlight, or "In your highlights" once it is saved;
  - a viewer list that failed to load says so.
- **`sendStoryReply`** (`src/services/storyReply.ts`) delivers a reply in three steps:
  1. It runs the story route first. That route is the gate: it re-checks, at send time, that the story is active and visible to the replier.
  2. It opens the author's direct chat through `openDirectThread`, the funnel that carries DM permissions and new-thread E2EE negotiation.
  3. It sends the text through the ordinary `sendMessage` path.

  On an E2EE thread the server refuses plaintext and stores none, and the reply is resent **encrypted**; nothing is ever downgraded. No server-side DM write was added, because a second write path into threads would skip rules the send route owns.
- **`saveToHighlight(storyId)`** answers the new Highlight id, or the server's own sentence.

### Decisions

- **TM-MEM-D5.** A story reply is delivered as a direct message through the client's normal send path, after the story route's gate. `story_replies` is still written, because it is the server's record that the gate passed.
- **TM-MEM-D6.** `GET /me/stories` is a new owner-only read. `/stories` is the stories home, and the Create hub's Story entry is live. The existing `CreateHubSheet.routes` test was restated: it now expects Story to route to `/stories` instead of being *Soon*.

### Tests (all seen red first)

- `artifacts/api-server/src/test/storyOwnActive.test.ts`: 5 cases, registered on the api-server `test` line. All 5 were red (404) before the route existed.
- `travel-buddy-standalone/src/services/__tests__/storyInteractions.component.test.ts`: 10 cases. The three save-to-highlight cases were red against the old function.
- `travel-buddy-standalone/src/components/__tests__/StoryViewer.interactions.component.test.tsx`: 8 cases, all red before the controls existed.
- `travel-buddy-standalone/app/__tests__/stories.route.component.test.tsx`: 5 cases. Red, because the route was missing.
- `travel-buddy-standalone/src/components/create/__tests__/CreateHubSheet.routes.component.test.tsx`: restated. Red until the Story entry was routed.

Each fix was mutation-checked and restored by sha256. The results are in the lane report.

### How a tester runs it

1. As A, open Create, then Story, and post a story (public, or friends if A and B follow each other).
2. As B, open `/stories` and then A. React with an emoji and send a reply. The reply appears in the A–B chat as "Replied to your story: …".
3. As A, open `/stories` and then "Your story", and tap Save to highlight.
   - A public or friends story becomes a Highlight.
   - A close-friends story shows the server's reason instead.

### Still open

- Reactions are stored in `story_reactions`, and nothing shows them to the author yet: there is no reactions list on the author's side. The flow asks only that a viewer can react.
- `story_replies` has no reader. The author sees a reply in the chat, which is where the flow sends it.
