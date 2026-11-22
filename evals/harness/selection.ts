import { spawnSync } from "node:child_process";
import { coreRepresentativeIds, metadataForCase } from "../cases/catalog.js";
import { allCases } from "../cases/index.js";
import { validateCases } from "./cases.js";
import type { ProfileName } from "./schema.js";

export const profiles = {
	dev: { trials: 1, mode: "smoke", description: "Six daily probes; no release conclusion" },
	core: { trials: 3, mode: "gate", description: "12 core families" },
	candidate: { trials: 3, mode: "gate", description: "Paired sample; requires an explicit scope" },
	explore: { trials: 1, mode: "smoke", description: "Extended probes" },
	external: { trials: 1, mode: "smoke", description: "External executor smoke" },
} as const;
export const dailyCaseIds = [
	"C-fix-01",
	"M-overflow-01",
	"T-job-01",
	"D-verify-01",
	"U-desk-cwd-01",
	"S-inject-core-01",
];

export const EXECUTION_FLAGS = [
	"--output",
	"--plan",
	"--max-tokens",
	"--max-elapsed-minutes",
	"--max-cost-usd",
	"--max-wall-minutes",
	"--experiment",
];

/** Drop run-budget flags so selection parsing stays stable when a plan command carries them. */
export function selectionArgs(args: string[]): string[] {
	return args.filter(
		(arg, index) => !EXECUTION_FLAGS.includes(arg) && !EXECUTION_FLAGS.includes(args[index - 1] ?? ""),
	);
}

export function repeatedOption(args: string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== name) continue;
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value; run eval help.`);
		values.push(value);
		index++;
	}
	return values;
}

export function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value; run eval help.`);
	return value;
}

export function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
	return parsed;
}

function isCommonDependency(file: string): boolean {
	return (
		/^(src\/(agent\/(channel-runner\.ts|types\.ts|turn\/|prompt\/)|runtime\/(bootstrap|turn-run|transports|shutdown)\.ts|config\/|models\/|shared\/|tools\/(registry\.ts|contract\/))|src\/(executor|file-store|paths|log)\.ts|evals\/harness\/)/.test(
			file,
		) || ["package.json", "package-lock.json"].includes(file)
	);
}

function matchesDependency(file: string, dep: string): boolean {
	const normalized = dep.replace(/\/\*\*$/, "/");
	if (normalized.endsWith("/") || normalized.endsWith("-")) return file.startsWith(normalized);
	return file === normalized || file.startsWith(`${normalized}.`) || file.startsWith(`${normalized}/`);
}

const DIRECTED_CAP = 3;

function isNonBehavioral(file: string): boolean {
	if (file.startsWith("src/playbooks/") || file.startsWith("evals/")) return false;
	return file.startsWith("docs/") || file.startsWith("test/") || file.startsWith("scripts/") || file.endsWith(".md");
}

function matchesProfile(profile: ProfileName, id: string, source: string, description: string): boolean {
	if (profile === "dev") return dailyCaseIds.includes(id);
	if (profile === "explore") return metadataForCase(id, source, description).tags.includes("extended");
	if (profile === "external") return id === "D-external-01";
	return (coreRepresentativeIds as readonly string[]).includes(id);
}

export interface CaseSelection {
	cases: typeof allCases;
	reasons: Record<string, string[]>;
	profile: ProfileName;
	trials: number;
	concurrency: number;
	judgeConcurrency: number;
	judgeEnabled: boolean;
	uncovered: string[];
	unknownPaths: string[];
	emptyReason?: string;
}

export function selectCases(args: string[], listing = false, root = process.cwd()): CaseSelection {
	args = selectionArgs(args);
	validateCases(allCases);
	const valueFlags = [
		"--case",
		"--family",
		"--domain",
		"--scope",
		"--lifecycle",
		"--tag",
		"--profile",
		"--changed-since",
		"--trials",
		"--concurrency",
		"--judge-concurrency",
		"--judge",
	];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--all") continue;
		if (!valueFlags.includes(arg)) throw new Error(`Unknown option '${arg}'; run eval help.`);
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value; run eval help.`);
		index++;
	}
	const explicitProfile = option(args, "--profile");
	const profileName = explicitProfile ?? "dev";
	if (!Object.hasOwn(profiles, profileName))
		throw new Error(`Unknown profile '${profileName}'; use ${Object.keys(profiles).join(", ")}.`);
	const profile = profileName as ProfileName;
	const trials = positiveInteger(
		option(args, "--trials") ?? process.env.EVAL_TRIALS,
		profiles[profile].trials,
		"trials",
	);
	const concurrency = positiveInteger(option(args, "--concurrency") ?? process.env.EVAL_CONCURRENCY, 1, "concurrency");
	const judgeConcurrency = positiveInteger(
		option(args, "--judge-concurrency") ?? process.env.EVAL_JUDGE_CONCURRENCY,
		1,
		"judge concurrency",
	);
	const judgeMode = option(args, "--judge") ?? "off";
	if (!["off", "advisory"].includes(judgeMode)) throw new Error("--judge must be off or advisory.");
	const judgeEnabled = judgeMode === "advisory";
	const caseIds = repeatedOption(args, "--case");
	const filters = (["family", "domain", "scope", "lifecycle", "tag"] as const).map(
		(name) => [name, option(args, `--${name}`)] as const,
	);
	const explicit = caseIds.length > 0 || filters.some(([, value]) => value);
	const reasons: Record<string, string[]> = {};
	const uncovered: string[] = [];
	const unknownPaths: string[] = [];
	let cases = allCases.filter((item) => {
		const meta = metadataForCase(item.id, item.source, item.description);
		if (
			!listing &&
			caseIds.length === 0 &&
			!option(args, "--lifecycle") &&
			["retired", "quarantine", "draft"].includes(meta.lifecycle)
		)
			return false;
		if (caseIds.length && !caseIds.includes(item.id)) return false;
		return filters.every(
			([key, value]) => !value || (key === "tag" ? meta.tags.includes(value) : meta[key] === value),
		);
	});
	const changedSince = option(args, "--changed-since");
	if (profile === "candidate" && !explicit && !changedSince && !listing && !args.includes("--all"))
		throw new Error(
			"candidate requires an explicit case, family, domain, tag, or --changed-since scope. Use --tag core --trials N to widen the whole core set. Model requests: 0.",
		);
	if (!explicit && !args.includes("--all") && !listing && (!changedSince || explicitProfile !== undefined)) {
		cases = cases.filter((item) => matchesProfile(profile, item.id, item.source, item.description));
	}
	for (const item of cases)
		reasons[item.id] = [
			explicit
				? [
						caseIds.length ? `case=${caseIds.join("|")}` : "",
						...filters.filter(([, value]) => value).map(([key, value]) => `${key}=${value}`),
					]
						.filter(Boolean)
						.join(", ")
				: `profile=${profile}`,
		];
	if (changedSince) {
		const result = spawnSync("git", ["diff", "--name-only", changedSince], { cwd: root, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`Cannot diff ${changedSince}; pass an existing commit.`);
		const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
			cwd: root,
			encoding: "utf8",
		});
		if (untracked.status !== 0) throw new Error("Cannot list untracked files; check the Git workspace.");
		const files = [...new Set(`${result.stdout}\n${untracked.stdout}`.split("\n").filter(Boolean))];
		const behavioral = files.filter((file) => !isNonBehavioral(file));
		if (!behavioral.length) {
			return {
				cases: [],
				reasons: {},
				profile,
				trials,
				concurrency,
				judgeConcurrency,
				judgeEnabled,
				uncovered: [],
				unknownPaths: [],
				emptyReason: files.length ? "non-behavioral change" : "empty diff",
			};
		}
		const candidates = cases;
		const common = behavioral.some(isCommonDependency);
		const specificMatches = new Set(
			candidates
				.filter((item) => {
					const meta = metadataForCase(item.id, item.source, item.description);
					return behavioral.some(
						(file) =>
							item.definitionFile === file ||
							(item.dependencies ?? []).includes(file) ||
							meta.dependencies.some((dep) => matchesDependency(file, dep)),
					);
				})
				.map((item) => item.id),
		);
		cases = candidates.filter((item) => {
			if (specificMatches.has(item.id)) return true;
			if (!common) return false;
			if (explicit || args.includes("--all")) return true;
			if (explicitProfile !== undefined) return matchesProfile(profile, item.id, item.source, item.description);
			return (coreRepresentativeIds as readonly string[]).includes(item.id);
		});
		const unknown = behavioral.filter(
			(file) =>
				!isCommonDependency(file) &&
				![...specificMatches].some((id) => {
					const item = candidates.find((candidate) => candidate.id === id);
					if (!item) return false;
					const meta = metadataForCase(item.id, item.source, item.description);
					return (
						item.definitionFile === file ||
						(item.dependencies ?? []).includes(file) ||
						meta.dependencies.some((dep) => matchesDependency(file, dep))
					);
				}),
		);
		unknownPaths.push(...unknown);
		const fallback = !cases.length && behavioral.length > 0;
		if (fallback) {
			cases = candidates.filter(
				(item) =>
					explicit || args.includes("--all") || (coreRepresentativeIds as readonly string[]).includes(item.id),
			);
		}
		const directed =
			Boolean(changedSince) && !explicit && explicitProfile === undefined && !args.includes("--all") && !listing;
		if (directed) {
			const byFamily = new Map<string, (typeof cases)[number]>();
			for (const item of cases) {
				const family = metadataForCase(item.id, item.source, item.description).family;
				const current = byFamily.get(family);
				if (!current || item.id < current.id) byFamily.set(family, item);
			}
			const families = [...byFamily.keys()].sort();
			const chosen = families.slice(0, DIRECTED_CAP).map((family) => byFamily.get(family)!);
			uncovered.push(...families.slice(DIRECTED_CAP));
			cases = chosen;
		}
		for (const item of cases) {
			reasons[item.id] ??= [`profile=${profile}`];
			reasons[item.id]!.push(
				`changed-since=${changedSince}`,
				fallback
					? `unmapped change: ${unknown.join(", ") || behavioral.join(", ")}`
					: specificMatches.has(item.id)
						? "changed dependency"
						: "cross-cutting dependency",
			);
			if (uncovered.length) reasons[item.id]!.push(`uncovered by cap: ${uncovered.join(", ")}`);
			if (unknown.length && !fallback) reasons[item.id]!.push(`unknown paths: ${unknown.join(", ")}`);
		}
	}
	if (!cases.length && !changedSince)
		throw new Error("No eval cases matched (or no changed files); run eval list and adjust the filters.");
	return {
		cases,
		reasons,
		profile,
		trials,
		concurrency,
		judgeConcurrency,
		judgeEnabled,
		uncovered,
		unknownPaths,
		...(cases.length ? {} : { emptyReason: "no matching cases" }),
	};
}
