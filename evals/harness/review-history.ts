import type { GradeResult, HumanReviewRecord, TrialRecord } from "./schema.js";

/** Read-only support for historical archives; never used to authorize new evaluation results. */
function isModelDecision(grade: GradeResult): boolean {
	if (grade.graderKind) return grade.graderKind === "model";
	// Fall back to heuristics only for archived records written before graderKind existed.
	return (
		grade.score !== undefined || grade.graderId.includes("faithfulness") || grade.graderId.includes("model-judge")
	);
}

export function humanReviewCalibration(
	records: TrialRecord[],
	reviews: HumanReviewRecord[],
): { reviewed: number; agreed: number; falsePass: number; falseFail: number; agreement?: number } {
	const modelGrades = new Map<string, GradeResult["status"]>(
		records.flatMap((record) =>
			record.grades
				.filter(isModelDecision)
				.map((grade) => [`${record.caseId}\0${record.trial}\0${grade.graderId}`, grade.status] as const),
		),
	);
	const latest = new Map<string, HumanReviewRecord>();
	for (const review of reviews) {
		const key = `${review.caseId}\0${review.trial}\0${review.graderId}`;
		if (modelGrades.has(key) && review.cohort !== "development") latest.set(key, review);
	}
	const relevant = [...latest.entries()];
	const agreed = relevant.filter(([, review]) => review.verdict === "agree").length;
	const falsePass = relevant.filter(
		([key, review]) => modelGrades.get(key) === "pass" && review.verdict === "overturn-to-fail",
	).length;
	const falseFail = relevant.filter(
		([key, review]) => modelGrades.get(key) === "fail" && review.verdict === "overturn-to-pass",
	).length;
	return {
		reviewed: relevant.length,
		agreed,
		falsePass,
		falseFail,
		agreement: relevant.length ? agreed / relevant.length : undefined,
	};
}
