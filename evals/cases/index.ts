import { capabilityCases } from "./capability.js";
import { coreFamilyCases } from "./core-families.js";
import { coreRenovatedCases } from "./core-renovated.js";
import { extendedFamilyCases } from "./extended-families.js";
import { memoryRecallQualityCases } from "./memory-recall-quality.js";
import { regressionCases } from "./regression.js";
import { safetyCases } from "./safety.js";
import { taskLoopQualityCases } from "./task-loop-quality.js";

export const allCases = [
	...regressionCases,
	...safetyCases,
	...capabilityCases,
	...memoryRecallQualityCases,
	...taskLoopQualityCases,
	...coreRenovatedCases,
	...coreFamilyCases,
	...extendedFamilyCases,
];
