/**
 * Global Input Intelligence — SuggestionAction.
 *
 * Mirrors PGIIA spec §43 (Routing and Action Resolution) EXACTLY. Every
 * suggestion that looks tappable resolves through this canonical action /
 * destination contract. The client's de-facto routing table
 * (`components/search/searchNav.tsx#resolveRoute`) is the runtime that
 * `open_entity` / `submit_search` eventually dispatch through — this type
 * formalises it without forking it (later phases wire the dispatcher).
 */
import type { EntityType } from './inputContext.ts';

/**
 * §43 — the closed set of actions a suggestion can request. All action
 * suggestions use the same authorization gate as the target action itself
 * (§47) — dispatching is a later-phase concern; this only names the contract.
 */
export type SuggestionAction =
  | { type: 'open_entity'; entityType: EntityType; entityId: string }
  | { type: 'replace_text'; text: string }
  | { type: 'set_structured_value'; value: unknown }
  | { type: 'submit_search'; query: string }
  | { type: 'add_to_trip'; entityId: string }
  | { type: 'share_entity'; entityType: EntityType; entityId: string }
  | { type: 'drop_pin' }
  | { type: 'open_compass'; context: unknown };

/** Discriminant union tag helper — the set of valid action `type` values. */
export type SuggestionActionType = SuggestionAction['type'];
