/**
 * §32/§34 — the shape of one row in a SHIPPED local dictionary.
 *
 * Deliberately minimal, and the omissions are the point.
 *
 * NO ENTITY ID, NO ROUTE, NO ACTION. A dictionary entry is a NAME the client
 * ships, not an entity the server resolved. The moment one of these carried an
 * `entityId` the client would be asserting a canonical identity nobody handed
 * it, and the row it produces could resolve somewhere the server never said it
 * did — which is the §13 dead-row / §2 fabrication failure, arrived at from the
 * offline side. `code` exists for PROVENANCE (it is what the artifact was
 * generated from, and what a test pins it against); it is never projected onto
 * a suggestion as an identity.
 *
 * `aliases` are matched on and NEVER displayed: "uk" finds "United Kingdom",
 * and "United Kingdom" is what the field shows and inserts, so the app's own
 * display spelling survives an offline selection (§10).
 */
export interface LocalDictionaryEntry {
  /** The display spelling. The app's own, never a re-invented one. */
  readonly label: string;
  /** Matched on, never shown. Colloquial / historical / abbreviated forms. */
  readonly aliases?: readonly string[];
  /**
   * Provenance only — the code or key this entry was generated from. NEVER
   * projected as `entityId`: see the header above.
   */
  readonly code?: string;
}
