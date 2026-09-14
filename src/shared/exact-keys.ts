/**
 * Compile-time completeness check for a runtime key list paired with a config interface. Assign
 * the result to a `const` typed `true` (then `void` it to satisfy `noUnusedLocals`): if `K` is
 * missing any key of `T`, the check's type becomes `never` and the assignment fails to
 * typecheck. This is what keeps a documentation-coverage test's key list (e.g.
 * `SETTINGS_TOP_LEVEL_KEYS` in `settings.ts`) from silently drifting out of sync with the
 * interface it documents when a field is added — `npm run typecheck` catches it, not a human
 * remembering to update two places.
 *
 * Only checks for *missing* keys. Pair the key list's own type with
 * `satisfies readonly (keyof T)[]` to also reject an extra or misspelled key.
 */
export type AssertNoMissingKeys<T, K extends readonly (keyof T)[]> = Exclude<keyof T, K[number]> extends never
	? true
	: never;
