---
name: gpt-5-mini reasoning tokens can eat the whole completion budget
description: A gpt-5-mini call can silently return empty content because hidden reasoning tokens consumed the entire max_completion_tokens budget, not because of any bug in the surrounding code.
---

# gpt-5-mini reasoning tokens can eat the whole completion budget

**Rule:** When a `gpt-5-mini` (or similar reasoning-capable) chat completion call intermittently returns empty/blank content — especially inside a larger prompt with tool-call context — suspect the token budget before suspecting prompt logic or the calling code. By default the model spends `max_completion_tokens` on internal reasoning first; a large or tool-heavy prompt can consume the entire budget on reasoning and leave zero tokens for the visible answer.

**Why:** Compass's `/api/compass/ask` appeared to "hang" — it wasn't infinite, it took ~30s round-tripping through a tool-calling loop and a re-prompt, both of which silently returned empty completions and fell through to a hardcoded fallback message. A direct API test confirmed: no `reasoning_effort` param spent ~700 reasoning tokens on a trivial prompt; `"low"` cut that to ~64; `"minimal"` to 0 — with full visible output and 2-3x lower latency in all cases.

**How to apply:** Add an explicit `reasoning_effort` ("low" for calls needing visible reasoning quality, "minimal" for classifiers/simple extraction) to any gpt-5-mini call in this codebase, especially ones with tool-call context or a fixed `max_completion_tokens`. Don't casually bump `max_completion_tokens` on a call without checking whether test fakes pattern-match on that exact value (e.g. compass tests match the intent classifier call by `max_completion_tokens === 60 && temperature === 0`).
