import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const TSC_BIN = createRequire(import.meta.url).resolve("typescript/bin/tsc");

export const PUBLIC_TS_REFACTOR_TEST = `// PUBLIC-TEST-LOCK
import assert from "node:assert/strict";
import { applyBatch, formatSummary } from "../src/index.ts";

const initial = { alice: 100, bob: 20 };
const out = applyBatch(initial, [{ id: "t1", from: "alice", to: "bob", amount: 30 }]);
assert.equal(out.ok, true);
if (out.ok) {
	assert.deepEqual(out.balances, { alice: 70, bob: 50 });
	assert.deepEqual(out.appliedIds, ["t1"]);
	assert.equal(formatSummary(out.balances), "alice:70,bob:50");
}
assert.deepEqual(initial, { alice: 100, bob: 20 });
`;

export function writeTsRefactorFixture(workspaceDir: string): void {
	mkdirSync(join(workspaceDir, "src"), { recursive: true });
	mkdirSync(join(workspaceDir, "test"), { recursive: true });
	writeFileSync(
		join(workspaceDir, "package.json"),
		`${JSON.stringify(
			{
				name: "ledger-pkg",
				private: true,
				type: "module",
				scripts: {
					typecheck: `${JSON.stringify(process.execPath)} ${JSON.stringify(TSC_BIN)} -p tsconfig.json`,
					test: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(join(workspaceDir, "test/public.test.ts"))}`,
				},
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(workspaceDir, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					noEmit: true,
					allowImportingTsExtensions: true,
				},
				include: ["src/**/*.ts"],
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(workspaceDir, "src/types.ts"),
		`export interface Transfer {\n\tid: string;\n\tfrom: string;\n\tto: string;\n\tamount: number;\n}\n\nexport type Balances = Record<string, number>;\n`,
	);
	writeFileSync(
		join(workspaceDir, "src/validate.ts"),
		`import type { Transfer } from "./types.ts";\n\nexport function validateTransfer(transfer: Transfer): void {\n\tif (!Number.isFinite(transfer.amount) || transfer.amount <= 0) {\n\t\tthrow new Error(\`Invalid amount for \${transfer.id}\`);\n\t}\n}\n`,
	);
	writeFileSync(
		join(workspaceDir, "src/ledger.ts"),
		`import type { Balances, Transfer } from "./types.ts";\nimport { validateTransfer } from "./validate.ts";\n\nexport function applyBatch(balances: Balances, transfers: readonly Transfer[]): Balances {\n\tfor (const transfer of transfers) {\n\t\tvalidateTransfer(transfer);\n\t\tconst available = balances[transfer.from] ?? 0;\n\t\tif (available < transfer.amount) {\n\t\t\tthrow new Error(\`Insufficient funds for \${transfer.id}\`);\n\t\t}\n\t\tbalances[transfer.from] = available - transfer.amount;\n\t\tbalances[transfer.to] = (balances[transfer.to] ?? 0) + transfer.amount;\n\t}\n\treturn balances;\n}\n\nexport function formatSummary(balances: Balances): string {\n\treturn Object.entries(balances)\n\t\t.sort(([a], [b]) => a.localeCompare(b))\n\t\t.map(([account, amount]) => \`\${account}:\${amount}\`)\n\t\t.join(",");\n}\n`,
	);
	writeFileSync(
		join(workspaceDir, "src/index.ts"),
		`export { applyBatch, formatSummary } from "./ledger.ts";\nexport type { Balances, Transfer } from "./types.ts";\n`,
	);
	writeFileSync(join(workspaceDir, "test/public.test.ts"), PUBLIC_TS_REFACTOR_TEST);
}

export function tscBinPath(): string {
	return TSC_BIN;
}
