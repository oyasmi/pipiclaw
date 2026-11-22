import type { InlineConfig, Reporter } from "vitest/node";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function rerunReporter(suite: "unit" | "e2e"): Reporter {
	return {
		onTestRunEnd(modules) {
			for (const module of modules) {
				if (module.ok()) continue;
				const e2eKind = module.relativeModuleId.split("/")[2];
				const script = e2eKind === "live" || e2eKind === "external" ? `test:e2e:${e2eKind}` : "test:e2e";
				const command = suite === "unit" ? "npm test --" : `npm run ${script} --`;
				const failed = [...module.children.allTests("failed")];
				if (failed.length === 0)
					console.error(`Re-run failed suite: ${command} ${shellQuote(module.relativeModuleId)}`);
				for (const test of failed) {
					const name = test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					const file = test.location
						? `${module.relativeModuleId}:${test.location.line}`
						: module.relativeModuleId;
					console.error(`Re-run ${test.fullName}\n  ${command} ${shellQuote(file)} -t ${shellQuote(`${name}$`)}`);
				}
			}
		},
	};
}

export function testReporting(
	suite: "unit" | "e2e",
): Pick<InlineConfig, "silent" | "includeTaskLocation" | "reporters" | "outputFile"> {
	return {
		silent: "passed-only",
		includeTaskLocation: true,
		reporters: [
			suite === "unit" ? "dot" : ["default", { summary: false }],
			"json",
			rerunReporter(suite),
			...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions" as const] : []),
		],
		outputFile: { json: `.cache/test-results/${suite}-${process.pid}.json` },
	};
}
