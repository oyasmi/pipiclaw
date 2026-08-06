// Copies the *.md runtime self-docs (playbooks) from src/ into dist/ after the
// TypeScript build, mirroring the src/<dir> -> dist/<dir> layout that src/paths.ts
// falls back to when no checkout source directory exists.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const DIRS = ["playbooks"];

for (const dir of DIRS) {
	const src = `src/${dir}`;
	const dst = `dist/${dir}`;
	mkdirSync(dst, { recursive: true });

	const wanted = new Set(readdirSync(src).filter((file) => file.endsWith(".md")));
	for (const file of readdirSync(dst)) {
		if (file.endsWith(".md") && !wanted.has(file)) {
			rmSync(`${dst}/${file}`, { force: true });
		}
	}
	for (const file of wanted) {
		copyFileSync(`${src}/${file}`, `${dst}/${file}`);
	}
}
