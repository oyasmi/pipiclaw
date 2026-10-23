// Runs the real initializer in another process, held immediately before publishing its table.
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";

registerHooks({
	resolve(specifier, context, next) {
		try { return next(specifier, context); } catch (error) {
			if (specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
				return next(`${specifier.slice(0, -3)}.ts`, context);
			}
			throw error;
		}
	},
});
const link = fs.linkSync;
fs.linkSync = (from, to) => {
	if (String(to).endsWith("/desk-bindings.json")) {
		process.stdout.write("publication-ready\n");
		fs.readSync(0, Buffer.alloc(1), 0, 1, null);
	}
	return link(from, to);
};
syncBuiltinESMExports();
const { initializeDefaultDesk } = await import("../../src/desk/default.ts");
initializeDefaultDesk({ workspaceDir: process.argv[2] });
