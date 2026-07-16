---
name: Design-subagent restyle audits
description: What to check after delegating a UI-only restyle of existing wired screens to the design subagent
---

Rule: after a design subagent rewrites an existing component, audit that every accepted prop is still consumed — typecheck passes even when handlers (onPress callbacks, upload states, follow CTAs) are silently dropped, because optional props compile fine unused.

**Why:** A delegated Passport identity-card restyle kept the prop signature but dropped avatar/cover/highlight/trust-info handlers and the public-profile follow button; only an architect review caught it.

**How to apply:** After any delegated restyle, grep the rewritten component for each prop name and confirm a render-side usage; check components shared by owner and public/visitor variants in both modes. sendFollowup to the same subagent fixes it cheaply with context intact.
