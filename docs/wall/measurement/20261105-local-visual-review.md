# Passport and Wall visual review — 2026-11-05

Reviewer: **Codex, AI local review**, under the user's request to complete missing work. This is a recorded design judgment against local screenshots, not a human signature, unfamiliar-user study, production check, or physical-device certification. No census grades or completion percentages were changed.

## Scope and method

Reviewed the user's IMG_2549–IMG_2555 screenshots, the exact W159/W167 questions in `W159-W167-design-review-packet.md`, and current production components. Opened the regenerated certification HTML, then rendered the actual five Wall renderers and Passport components in Chrome through React Native Web. The in-app browser was unavailable.

The richer fixture uses the repository's `assets/fallbacks/cafe.webp` as local synthetic content and real Lucide icons. It covers **50 Wall cards: five object types × typical/ceiling density × 320/360/390/411/430 CSS-pixel widths**. Every saved final screenshot was opened and visually inspected. Widths are fixture content widths, not claims about a specific phone. The current static certification artifact remains a separate reproducible proxy; its new digest is **`c910833f6aa8570d`**.

Fixture boundaries: network/account services are replaced, avatars use initials, video is the poster state, FullscreenPhoto retains its exact frame layout but does not open, and the Save button has a visually equivalent icon stub. Actual renderer layout, tokens, icons, text, image placement, contextual chips, and context threads are retained. The FriendButton function and styles are extracted unchanged from the app; its local status hook simulates send/cancel. This proves presentation and local state clarity, not persistence against production. Large-text fixtures simulate RN font scaling by multiplying text metrics; native font measurement and safe areas require device acceptance.

## Findings fixed

| Finding | Change | Evidence |
| --- | --- | --- |
| Passport member badge exceeded the card at 320px; follow control crowded the brand | Header wraps with a real gap; member/trust badges constrain and wrap their text | `passport-320-before.png` → `passport-320-fixed.png` |
| Large text truncated the identity beside the photo | Large-text Passport identity stacks vertically; location can use two lines | `passport-320-large-final.png`, `passport-390-large-final.png` |
| Large-text stamp lettering outgrew fixed artwork, and three columns truncated external labels | Tiny artwork lettering keeps the artwork scale; full outside labels still scale. Grid uses 3/2/1 columns as text grows | `passport-430-final.png`, `passport-390-large-final.png` |
| Wall video place text and action icons were dark on a dark card | Video explicitly requests light place/action treatment; light cards retain existing colors and saved accent | All `wall-*-*-final.png`; mounted test computes actual rendered contrast |
| Follow and pending friendship controls lacked explicit button semantics | Follow has a clear button label; pending request announces that it can be cancelled; other friend states are buttons | Local send/cancel flow and current source |

The stamp change preserves the full accessible artwork label and scalable surrounding name. It does not depend on AI artwork being generated: First Step, Trip Planner, First Post, and First Postcard have complete procedural frames, differentiated icons, and complete labels.

## W159 / W167 decisions

These are the AI reviewer's answers to the existing packet, not forged named-designer approval.

| Question | Local decision and evidence |
| --- | --- |
| W159 Q1: generous spacing across the set? | **Yes.** Byline, text, image, and actions remain separate groups across all 50 cards. No spacing-token change is needed. |
| W159 Q2: broken clipping/collision/orphan/wrapping? | **No remaining layout collision in the final Wall set.** At 320px, chips wrap deliberately into two rows. Place/reason previews use intentional ellipses. Video contrast was a real defect and is fixed. |
| W159 Q3: does 430px whitespace look deliberate? | **Yes.** Text measure stays short, image area remains primary, and the action row has a clear end-aligned bookmark. |
| W159 Q4: are the five types distinct? | **Yes.** Social post uses byline/text/media; Video has a dark body and play poster; Postcard has prominent experience date, full-width image and italic narrative without a social action row; Shared Moment foregrounds participants; Discovery carries its reason and outlined treatment. |
| W167 Q5: is one action row + three chips + one context thread already too dense? | **No, for these reviewed ceiling fixtures.** The 320px wrap is readable and the thread remains subordinate; at 390px all three chips fit on one row. Keep the current cap of three chips and one thread. |

No visual redesign or extra badges were introduced. No additional engineering change is identified by this finite review.

## Original screenshot reconciliation

| User evidence | Current status and proof boundary |
| --- | --- |
| IMG_2549–2550: Following with Add Friend / Request Sent | Local current UI distinguishes **Following**, **Send Friend Request**, and **Friend Request Sent**, explains that friendship requires acceptance, and preserves Following when the simulated friend request is sent/cancelled. This is a relationship-copy fix; a follow is not silently converted into mutual friendship. |
| IMG_2551: identical location pins, clipped stamp titles, 5 earned vs 4 displayed | Current normal-size and large-text screenshots show differentiated complete stamps. The collection explains that Stamps Earned also includes stamps received on posts; visible collection count is separate. Existing public count/pagination tests pass. This review does not assert what the user's current live counts are. |
| IMG_2552: clipped Discovery label and no selected Passport state | Fresh 320px tab captures show the full normal-size Discovery label and selected Passport. Large-text labels deliberately ellipsize within their targets; accessibility labels remain complete. Earlier route-selection/swipe tests cover actual and grouped paths. |
| IMG_2553: Share Post no-op, missing destinations | Current ShareSheet contains external/copy, profile repost, Memory, Highlight, and Telegraph flows; implementation and mounted/service evidence are recorded in `docs/media/completion-work-20261105.md`. This visual lane did not invoke an actual OS share sheet or send anything. |
| IMG_2554: empty own public Passport | No new failure is established solely by an empty account screenshot. The current owner-bound detail routes and private media guards were validated in the preceding media work; no fake content was added. |
| IMG_2555: saved content absent / misleading empty state | Current Saved distinguishes saved people/posts/gems and collections, preserves older saves, supports created collections and multiple filings, and uses “No collections yet” when only collections are empty. Existing root/collections implementation tests are the behavioral evidence, not this browser fixture. |

## Validation and remaining acceptance

- **64 distinct checks pass**: 36 Wall accessibility/design-system/large-text-grid checks, 25 Passport checks (one grid check overlaps), and four generated-render checks.
- Native app source typecheck passes. Test typecheck remains **144 diagnostics / 54 files**, with no increase or stale baseline. Import and mock guards pass. `git diff --check` passes.
- Generator output now removes CSS trailing whitespace before writing the artifact; manual edits to generated HTML are unnecessary.
- W168 still needs actual unfamiliar participants to establish comprehension. This AI assessment does not substitute for their responses.
- W146 production first-page timing and W149 physical-device frame measurements remain external runtime acceptance. Browser screenshots and synthetic data cannot establish them.
- Physical OS sharing, native text/safe-area rendering, and release/migration application remain in the existing release acceptance scope. Nothing was deployed or applied to production.

## Evidence and reproduction

Screenshots and SHA-256 source/artifact manifest are in [`local-review-20261105/`](./local-review-20261105/manifest.json). The local builder is [`build-review.cjs`](./local-review-20261105/build-review.cjs). Run it with the existing native dependencies, then serve its default `/tmp/portava-fullscreen-browser` output on loopback. The page accepts `?page=wall&width=320&density=ceiling` or `?page=passport&width=390&scale=2`. Keep the browser viewport at least as wide as the requested fixture width.

Representative final captures:

- [Passport, normal 430px](./local-review-20261105/passport-430-final.png)
- [Passport, large text at 320px](./local-review-20261105/passport-320-large-final.png)
- [Wall ceiling at 320px](./local-review-20261105/wall-320-ceiling-final.png)
- [Wall ceiling at 390px](./local-review-20261105/wall-390-ceiling-final.png)
- [Wall typical at 430px](./local-review-20261105/wall-430-typical-final.png)
- [Selected Passport and complete Discovery label at 320px](./local-review-20261105/tabs-320-passport-audit.png)

The saved images are local fixture evidence. They are not screenshots of rumazi.com or an installed release.
