import { capabilityCases } from "./capability.js";
import { memoryRecallQualityCases } from "./memory-recall-quality.js";
import { regressionCases } from "./regression.js";
import { safetyCases } from "./safety.js";

export const allCases = [...regressionCases, ...safetyCases, ...capabilityCases, ...memoryRecallQualityCases];
