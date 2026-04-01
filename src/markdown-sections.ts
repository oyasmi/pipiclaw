export interface MarkdownLevelOneSection {
	heading: string;
	content: string;
}

export function splitLevelOneSections(content: string): MarkdownLevelOneSection[] {
	const normalized = content.replace(/\r/g, "").trim();
	if (!normalized) {
		return [];
	}

	const lines = normalized.split("\n");
	const sections: MarkdownLevelOneSection[] = [];
	let currentHeading = "";
	let currentLines: string[] = [];

	const flush = (): void => {
		if (!currentHeading) {
			return;
		}
		const sectionContent = currentLines.join("\n").trim();
		if (!sectionContent) {
			return;
		}
		sections.push({ heading: currentHeading, content: sectionContent });
	};

	for (const line of lines) {
		if (line.startsWith("# ")) {
			flush();
			currentHeading = line.slice(2).trim();
			currentLines = [];
			continue;
		}
		if (currentHeading) {
			currentLines.push(line);
		}
	}

	flush();
	return sections;
}
