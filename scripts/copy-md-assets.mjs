// Copies the *.md runtime self-docs (playbooks) from src/ into dist/ after the
// TypeScript build, mirroring the src/<dir> -> dist/<dir> layout that src/paths.ts
// falls back to when no checkout source directory exists.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const DIRS = ["playbooks"];

for (const dir of DIRS) {
	const src = `src/${dir}`;
	const dst = `dist/${dir}`;
	rmSync(dst, { recursive: true, force: true });
	mkdirSync(dst, { recursive: true });
	for (const file of readdirSync(src)) {
		if (file.endsWith(".md")) {
			copyFileSync(`${src}/${file}`, `${dst}/${file}`);
		}
	}
}
