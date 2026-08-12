import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { isWithinAllowedRoots, resolveProjectAccessPolicy } from "../src/security/project-scope.js";
import type { SecurityConfig } from "../src/security/types.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-project-scope-");

function withProjectAccess(projectAccess: SecurityConfig["projectAccess"]): SecurityConfig {
	return { ...DEFAULT_SECURITY_CONFIG, projectAccess };
}

describe("resolveProjectAccessPolicy", () => {
	it("row 1: no projectAccess section — unconfigured, immutable, defaults to startupCwd", () => {
		const startupCwd = makeTempDir();
		const resolution = resolveProjectAccessPolicy(withProjectAccess(undefined), startupCwd);

		expect(resolution.configured).toBe(false);
		expect(resolution.mutable).toBe(false);
		expect(resolution.policy.defaultRoot).toBe(startupCwd);
		expect(resolution.policy.allowedRoots).toEqual([startupCwd]);
	});

	it("row 3: projectAccess present but fields omitted — configured, mutable, defaults to startupCwd", () => {
		const startupCwd = makeTempDir();
		const resolution = resolveProjectAccessPolicy(withProjectAccess({}), startupCwd);

		expect(resolution.configured).toBe(true);
		expect(resolution.mutable).toBe(true);
		expect(resolution.policy.defaultRoot).toBe(startupCwd);
		expect(resolution.policy.allowedRoots).toEqual([startupCwd]);
	});

	it("canonicalizes ~, resolves realpath, and folds defaultRoot into allowedRoots", () => {
		const root = makeTempDir();
		const projects = join(root, "projects");
		mkdirSync(projects, { recursive: true });

		const resolution = resolveProjectAccessPolicy(
			withProjectAccess({ defaultRoot: projects, allowedRoots: [] }),
			root,
		);

		expect(resolution.mutable).toBe(true);
		expect(resolution.policy.defaultRoot).toBe(projects);
		expect(resolution.policy.allowedRoots).toContain(projects);
	});

	it("disables mutation and falls back to startupCwd when defaultRoot doesn't resolve", () => {
		const startupCwd = makeTempDir();
		const resolution = resolveProjectAccessPolicy(
			withProjectAccess({ defaultRoot: join(startupCwd, "does-not-exist") }),
			startupCwd,
		);

		expect(resolution.configured).toBe(true);
		expect(resolution.mutable).toBe(false);
		expect(resolution.policy.defaultRoot).toBe(startupCwd);
		expect(resolution.diagnostics.some((d) => d.severity === "error")).toBe(true);
	});

	it("drops an invalid allowedRoots entry with a warning but keeps the rest usable", () => {
		const startupCwd = makeTempDir();
		const goodRoot = join(startupCwd, "good");
		mkdirSync(goodRoot, { recursive: true });

		const resolution = resolveProjectAccessPolicy(
			withProjectAccess({ defaultRoot: startupCwd, allowedRoots: [goodRoot, "relative/not-absolute"] }),
			startupCwd,
		);

		expect(resolution.mutable).toBe(true);
		expect(resolution.policy.allowedRoots).toContain(goodRoot);
		expect(resolution.diagnostics.some((d) => d.severity === "warning")).toBe(true);
	});
});

describe("isWithinAllowedRoots", () => {
	it("treats a root as within itself and its descendants only, not path-prefix lookalikes", () => {
		const policy = { defaultRoot: "/repo-a", allowedRoots: ["/repo-a"] };

		expect(isWithinAllowedRoots("/repo-a", policy)).toBe(true);
		expect(isWithinAllowedRoots("/repo-a/sub", policy)).toBe(true);
		expect(isWithinAllowedRoots("/repo-ab", policy)).toBe(false);
		expect(isWithinAllowedRoots("/repo-ab/sub", policy)).toBe(false);
	});
});
