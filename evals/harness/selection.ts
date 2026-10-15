import { spawnSync } from "node:child_process";
import { coreRepresentativeIds, familyCatalog, metadataForCase } from "../cases/catalog.js";
import { allCases } from "../cases/index.js";
import { validateCases } from "./cases.js";

export const profiles = {
	dev: { trials: 1, mode: "smoke", description: "Six daily probes; no release conclusion" },
	core: { trials: 3, mode: "gate", description: "12 core families" },
	candidate: { trials: 10, mode: "gate", description: "Paired version decision sample" },
	explore: { trials: 1, mode: "smoke", description: "Extended probes" },
	external: { trials: 1, mode: "smoke", description: "External executor smoke" },
} as const;
export type ProfileName = keyof typeof profiles;
export const dailyCaseIds = ["C-fix-01", "M-overflow-01", "T-job-01", "D-verify-01", "U-path-01", "S-inject-core-01"];

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

export function selectCases(args: string[], listing = false, root = process.cwd()) {
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
		option(args, arg);
		index++;
	}
	const profileName = option(args, "--profile") ?? "dev";
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
	const filters = (["case", "family", "domain", "scope", "lifecycle", "tag"] as const).map(
		(name) => [name, option(args, `--${name}`)] as const,
	);
	const explicit = filters.some(([, value]) => value);
	const reasons: Record<string, string[]> = {};
	let cases = allCases.filter((item) => {
		const meta = metadataForCase(item.id, item.source, item.description);
		if (
			!listing &&
			!option(args, "--case") &&
			!option(args, "--lifecycle") &&
			["retired", "quarantine", "draft"].includes(meta.lifecycle)
		)
			return false;
		return filters.every(
			([key, value]) =>
				!value ||
				(key === "case" ? item.id === value : key === "tag" ? meta.tags.includes(value) : meta[key] === value),
		);
	});
	const changedSince = option(args, "--changed-since");
	if (!explicit && !args.includes("--all") && !listing) {
		cases = cases.filter((item) =>
			profile === "dev" && !changedSince
				? dailyCaseIds.includes(item.id)
				: profile === "explore"
					? metadataForCase(item.id, item.source, item.description).tags.includes("extended")
					: profile === "external"
						? item.id === "D-external-01"
						: (coreRepresentativeIds as readonly string[]).includes(item.id),
		);
	}
	for (const item of cases)
		reasons[item.id] = [
			explicit
				? filters
						.filter(([, value]) => value)
						.map(([key, value]) => `${key}=${value}`)
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
		const candidates = cases;
		const common = files.some(
			(file) =>
				/^(src\/(agent|tools|runtime|config|models|playbooks|shared|security)\/|src\/(executor|file-store|paths)\.ts|evals\/harness\/)/.test(
					file,
				) || ["package.json", "package-lock.json"].includes(file),
		);
		cases = candidates.filter((item) => {
			const meta = metadataForCase(item.id, item.source, item.description);
			const roots = familyCatalog.find((family) => family.id === meta.family)?.dependencies ?? [];
			return (
				common ||
				files.some(
					(file) =>
						item.definitionFile === file ||
						(item.dependencies ?? []).includes(file) ||
						roots.some((root) => file.startsWith(root.replace(/\/\*\*$/, "/"))),
				)
			);
		});
		const fallback = !cases.length && files.length > 0;
		if (fallback)
			cases = candidates.filter(
				(item) =>
					explicit || args.includes("--all") || (coreRepresentativeIds as readonly string[]).includes(item.id),
			);
		for (const item of cases)
			reasons[item.id]!.push(
				`changed-since=${changedSince}`,
				fallback ? "unmapped change: conservative fallback within selection" : "changed dependency",
			);
	}
	if (!cases.length)
		throw new Error("No eval cases matched (or no changed files); run eval list and adjust the filters.");
	return { cases, reasons, profile, trials, concurrency, judgeConcurrency, judgeEnabled };
}
