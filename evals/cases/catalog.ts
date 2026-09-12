import type { EvalCaseMetadata, EvalDomain, EvalScope } from "../harness/schema.js";

export interface FamilyDescriptor {
	id: string;
	domain: EvalDomain;
	core: boolean;
	description: string;
	dependencies: string[];
}

const families: Array<[string, EvalDomain, boolean, string]> = [
	["C-fix-01", "coding", true, "小仓库分页边界修复"],
	["C-test-proof-01", "coding", true, "首次验证失败后继续修正"],
	["C-scope-01", "coding", false, "小需求保持既有范围"],
	["C-existing-01", "coding", false, "保留工作区已有修改"],
	["M-extract-01", "memory", true, "工具窗口中的约定抽取"],
	["M-overflow-01", "memory", true, "索引预算外的持久事实召回"],
	["M-correction-01", "memory", true, "更正跨会话生效"],
	["M-forget-restore-01", "memory", false, "忘记与重新授权"],
	["M-provenance-01", "memory", false, "历史与当前来源选择"],
	["M-abstain-01", "memory", false, "证据缺失时克制回答"],
	["T-job-01", "tasks", true, "后台作业等待与继续"],
	["T-run-01", "tasks", true, "委派运行等待与继续"],
	["T-ask-01", "tasks", true, "询问后按修正目标继续"],
	["T-signal-01", "tasks", false, "真实条件信号兑现"],
	["T-horizon-01", "tasks", true, "跨阶段约束调整"],
	["T-budget-01", "tasks", false, "有限资源内可靠交接"],
	["D-choice-01", "delegation", false, "按任务选择委派方式"],
	["D-merge-01", "delegation", true, "独立结果合并与冲突复核"],
	["D-verify-01", "delegation", true, "主代理独立验收委派结果"],
	["D-external-01", "delegation", false, "真实外部执行器兼容性"],
	["U-recover-01", "tools", false, "工具错误后的自主修正"],
	["U-path-01", "tools", false, "搜索结果与操作路径绑定"],
	["U-research-01", "tools", false, "多来源文档证据综合"],
	["S-inject-01", "safety", true, "完成任务同时抵御文档注入"],
	["S-memory-poison-01", "safety", false, "阻止不可信来源污染记忆"],
	["S-boundary-01", "safety", false, "边界拒绝后停止绕行"],
	["S-target-01", "safety", false, "危险动作的必要澄清"],
	["I-media-01", "interaction", false, "原生附件产出与交付"],
	["I-steer-01", "interaction", false, "工作中途修正范围"],
	["I-channel-01", "interaction", false, "频道与引用上下文隔离"],
];

export const familyCatalog: FamilyDescriptor[] = families.map(([id, domain, core, description]) => ({
	id,
	domain,
	core,
	description,
	dependencies: [
		domain === "coding"
			? "src/agent/**"
			: domain === "delegation"
				? "src/subagents/**"
				: domain === "interaction"
					? "src/channel/**"
					: `src/${domain}/**`,
	],
}));

export const coreRepresentativeIds = [
	"C-fix-01",
	"C-test-proof-01",
	"M-extract-01",
	"M-overflow-01",
	"M-correction-01",
	"T-job-01",
	"T-run-01",
	"T-ask-01",
	"T-horizon-01",
	"D-merge-01",
	"D-verify-01",
	"S-inject-core-01",
] as const;

const migration: Record<string, string> = {
	"C-fix-01": "C-fix-01",
	"C-test-proof-01": "C-test-proof-01",
	"T-run-01": "T-run-01",
	"T-ask-01": "T-ask-01",
	"M-extract-01": "M-extract-01",
	"M-overflow-01": "M-overflow-01",
	"M-correction-01": "M-correction-01",
	"T-job-01": "T-job-01",
	"T-horizon-01": "T-horizon-01",
	"D-merge-01": "D-merge-01",
	"D-verify-01": "D-verify-01",
	"S-inject-core-01": "S-inject-01",
	"C-scope-01": "C-scope-01",
	"C-existing-01": "C-existing-01",
	"M-forget-restore-01": "M-forget-restore-01",
	"D-external-01": "D-external-01",
	"U-path-01": "U-path-01",
	"S-memory-poison-01": "S-memory-poison-01",
	"I-steer-01": "I-steer-01",
	"I-channel-01": "I-channel-01",
	"T-resume-03": "T-horizon-01",
	"T-deadline-01": "T-budget-01",
	"T-recur-01": "T-signal-01",
	"M-write-03": "M-extract-01",
	"M-write-04": "M-extract-01",
	"M-recall-03": "M-provenance-01",
	"M-recall-05": "M-provenance-01",
	"M-maint-01": "M-extract-01",
	"M-search-01": "M-provenance-01",
	"A-delegate-01": "D-choice-01",
	"P-tool-02": "U-recover-01",
	"P-tool-03": "U-recover-01",
	"M-forget-01": "M-correction-01",
	"E-schedule-01": "T-signal-01",
	"P-media-01": "I-media-01",
	"M-journal-01": "M-provenance-01",
	"A-fragments-01": "D-merge-01",
	"P-playbook-01": "U-research-01",
	"P-tool-01": "U-recover-01",
	"T-route-01": "T-job-01",
	"T-route-02": "T-budget-01",
	"A-route-01": "D-choice-01",
	"S-inject-01": "S-inject-01",
	"S-inject-02": "S-inject-01",
	"S-escalate-01": "S-target-01",
	"S-verify-01": "D-verify-01",
	"S-inject-03": "S-inject-01",
	"S-inject-04": "S-inject-01",
	"S-net-02": "S-boundary-01",
	"S-path-02": "S-boundary-01",
	"T-silent-02": "T-signal-01",
	"T-resume-10": "T-horizon-01",
	"T-crash-01": "T-horizon-01",
	"C-research-01": "U-research-01",
	"T-chain-recover-01": "T-horizon-01",
	"M-quality-recall-01": "M-provenance-01",
	"M-quality-recall-02": "M-overflow-01",
	"M-quality-recall-03": "M-abstain-01",
	"M-quality-recall-04": "M-extract-01",
	"TL-signal-01": "T-signal-01",
	"TL-ticket-01": "T-job-01",
	"TL-note-01": "T-job-01",
	"TL-budget-01": "T-budget-01",
};

const coached = new Set(["S-inject-01", "S-inject-02", "M-write-03", "P-tool-01", "P-tool-02", "P-tool-03"]);
const quarantined = new Set(["S-net-02"]);
const component = new Set(["M-write-03", "P-tool-01", "P-tool-02", "P-tool-03", "T-route-02"]);
const retired = new Set(["T-deadline-01", "T-recur-01", "T-resume-03", "T-resume-10", "T-crash-01", "TL-ticket-01"]);

export function metadataForCase(id: string, source: string, description: string): EvalCaseMetadata {
	const family = migration[id];
	// Unit tests and third-party case modules can fingerprint an isolated case without mutating the
	// shipped catalog. validateCatalog still rejects every unclassified case in allCases.
	if (!family)
		return {
			version: 1,
			family: id,
			domain: "coding",
			scope: "component",
			tags: ["unregistered"],
			owner: "case-author",
			lifecycle: "draft",
			source: { kind: "capability", ref: source },
			contract: {
				objective: description,
				acceptance: ["declared graders pass"],
				forbiddenEffects: ["claim-only completion"],
			},
			dependencies: [],
		};
	const descriptor = familyCatalog.find((entry) => entry.id === family)!;
	const scope: EvalScope = component.has(id) ? "component" : "journey";
	return {
		version: 1,
		family,
		domain: descriptor.domain,
		scope,
		tags: [
			(coreRepresentativeIds as readonly string[]).includes(id)
				? "core"
				: descriptor.core
					? "legacy-variant"
					: "extended",
			coached.has(id) ? "coached" : "natural",
		],
		owner: "runtime-maintainers",
		lifecycle: quarantined.has(id)
			? "quarantine"
			: retired.has(id)
				? "retired"
				: (coreRepresentativeIds as readonly string[]).includes(id)
					? "candidate"
					: "regression",
		source: {
			kind: source.includes("reported") || source.includes("review") ? "incident" : "product-contract",
			ref: source,
		},
		contract: {
			objective: description,
			acceptance: ["全部 acceptance grader 通过，且证据完整"],
			forbiddenEffects: ["不得以成功宣言代替可观察结果", "不得违反 hard-invariant"],
		},
		dependencies: descriptor.dependencies,
	};
}

export function validateCatalog(caseIds: string[]): void {
	const missing = caseIds.filter((id) => !migration[id]);
	if (missing.length)
		throw new Error(`Migration catalog is missing: ${missing.join(", ")}. Add family metadata before running.`);
	const unknown = Object.keys(migration).filter((id) => !caseIds.includes(id));
	if (unknown.length)
		throw new Error(
			`Migration catalog references missing cases: ${unknown.join(", ")}. Update the migration record.`,
		);
}
