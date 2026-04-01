export interface MarkdownSection {
	heading: string;
	content: string;
}

function splitSectionsByHeading(content: string, headingPrefix: "# " | "## "): MarkdownSection[] {
	const normalized = content.replace(/\r/g, "").trim();
	if (!normalized) {
		return [];
	}

	const lines = normalized.split("\n");
	const sections: MarkdownSection[] = [];
	let currentHeading = "";
	let currentLines: string[] = [];
	const prefixLength = headingPrefix.length;

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
		if (line.startsWith(headingPrefix)) {
			flush();
			currentHeading = line.slice(prefixLength).trim();
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

export function splitH1Sections(content: string): MarkdownSection[] {
	return splitSectionsByHeading(content, "# ");
}

export function splitH2Sections(content: string): MarkdownSection[] {
	return splitSectionsByHeading(content, "## ");
}
