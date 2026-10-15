/** Immutable public fixture text, shared with the independent oracle's preservation check. */
export function publicPaginationTest(hard: boolean): string {
	return `// PUBLIC-TEST-LOCK\nimport assert from 'node:assert/strict';\nimport { paginate } from '../src/paginate.js';\nassert.deepEqual(paginate(['a','b','c','d'], 1, 2), ['b','c']);\n${hard ? "assert.deepEqual(paginate(['a','b','c','d'], 0, 2), ['a','b']);\n" : ""}`;
}
