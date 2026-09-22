/**
 * Telegraph — the one way this package builds a keyed lookup table.
 *
 * WHY THIS MODULE EXISTS
 * ======================
 * `domain/telegraph/` decides things by looking a key up in a table: a message
 * subtype becomes a §21 search bucket, a §13.1 command name becomes the route
 * that owns it, a notification event type becomes a §19 attention band. Every
 * one of those tables was a plain object literal, and every one of those keys
 * arrives from outside — a client-written `messages.subtype`, a request body's
 * `type`, a stored `event_type`.
 *
 * A plain object literal is NOT a closed vocabulary. It inherits from
 * `Object.prototype`, so four keys it never declared answer TRUTHY:
 *
 *     ({}).constructor      // the Object function
 *     ({}).toString         // a function
 *     ({}).hasOwnProperty   // a function
 *     ({}).__proto__        // Object.prototype
 *
 * which means `TABLE[key]`, `TABLE[key] ?? fallback` and `key in TABLE` all
 * FAIL OPEN for those four: they take the branch reserved for a registered key
 * and hand the caller a native function where the types promise a string enum.
 * `src/test/telegraphDispatchTablePrototypeKeys.test.ts` records what each of
 * the three tables actually did — a search bucket that vanished from the JSON,
 * a 409 "wrong door" for a command nobody wrote, and a TypeError thrown out of
 * the notification dedupe path.
 *
 * THE FIX IS AT THE TABLE, NOT AT THE READER, AND THAT IS THE DESIGN
 * =================================================================
 * `dispatchTable` returns a FROZEN NULL-PROTOTYPE object. With no
 * `Object.prototype` behind it the four keys are simply absent, so every
 * existing reader — `if (hit)`, `?? null`, `key in table` — fails closed
 * WITHOUT being edited. That matters beyond tidiness: two of the three readers
 * live in files other lanes own, and a fix that required every present and
 * future reader to remember the hazard is not a fix, it is a convention.
 *
 * `hasEntry` and `lookup` are here for readers that want to say so explicitly.
 * They are belt to the table's braces, not a replacement for it: a table built
 * any other way is still wrong, which is why the test asserts the PROTOTYPE of
 * every exported table rather than only the behaviour of these two helpers.
 */

/**
 * The four keys a plain object literal answers truthy for without declaring
 * them. Exported so every dispatch-table test can iterate the same list rather
 * than each remembering three of four.
 *
 * `isPrototypeOf`, `valueOf`, `propertyIsEnumerable`, `toLocaleString` and the
 * four `__define*`/`__lookup*` accessors inherit too. These four are the ones
 * that are plausible as DATA — a subtype, a command name, an event type someone
 * types or fuzzes — and the test pins the full derivation so the list cannot
 * silently go stale if the runtime's prototype changes.
 */
export const PROTOTYPE_LOOKUP_KEYS = [
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
] as const;

export type PrototypeLookupKey = (typeof PROTOTYPE_LOOKUP_KEYS)[number];

/**
 * Build a lookup table whose keys are exactly the ones declared.
 *
 * Frozen as well as prototype-less: a table that can be written to at runtime
 * is a table an imported module can register a key in, and "which key won" then
 * depends on module evaluation order. Freezing makes the vocabulary a fact of
 * the source file.
 *
 * `__proto__` in the ENTRIES is handled correctly too, and that is not
 * theoretical: `Object.assign(Object.create(null), { __proto__: x })` would
 * silently drop the entry on a literal, so entries are copied with
 * `defineProperty` over `Reflect.ownKeys`, which copies it as a real own
 * property. A vocabulary that declared such a key would then HAVE it rather
 * than appearing to.
 */
export function dispatchTable<T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  const out = Object.create(null) as Record<string, T>;
  for (const key of Reflect.ownKeys(entries)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(entries, key);
    if (!descriptor) continue;
    Object.defineProperty(out, key, {
      value: (descriptor.get ? descriptor.get.call(entries) : descriptor.value) as T,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

/**
 * Does this table DECLARE this key?
 *
 * `Object.prototype.hasOwnProperty.call` rather than `table.hasOwnProperty`,
 * because the latter is the very method a null-prototype table does not have —
 * and on a table that is NOT null-prototype it is the method an attacker-named
 * key shadows.
 */
export function hasEntry(table: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/**
 * The value for a declared key, or `null`.
 *
 * `null` and not `undefined`: a caller that means "absent" reads better with an
 * explicit null, and a table whose declared values may themselves be undefined
 * would otherwise be indistinguishable from a miss.
 */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string | null | undefined): T | null {
  if (key === null || key === undefined) return null;
  if (!hasEntry(table as Readonly<Record<string, unknown>>, key)) return null;
  const value = table[key];
  return value === undefined ? null : value;
}
