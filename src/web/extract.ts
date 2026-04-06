import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

interface DomNode {
	nodeType: number;
	textContent: string | null;
	childNodes?: Iterable<unknown>;
}

interface DomElement extends DomNode {
	tagName: string;
	getAttribute(name: string): string | null;
	children?: Iterable<unknown>;
}

function createSilentVirtualConsole(): VirtualConsole {
	const virtualConsole = new VirtualConsole();
	virtualConsole.on("jsdomError", (_error: unknown) => {
		// Ignore parser noise such as malformed inline CSS. These pages are still
		// often readable enough for Readability / text extraction, and forwarding
		// jsdom's internal parse warnings pollutes Pipiclaw runtime logs.
	});
	return virtualConsole;
}

function createDom(html: string, url?: string): JSDOM {
	const options = {
		virtualConsole: createSilentVirtualConsole(),
		...(url ? { url } : {}),
	};
	return new JSDOM(html, options);
}

function normalizeWhitespace(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function escapeMarkdown(value: string): string {
	return value.replace(/([\\`*_{}[\]()#+.!>-])/g, "\\$1");
}

function renderNode(node: unknown): string {
	const domNode = node as DomNode;
	if (domNode.nodeType === TEXT_NODE) {
		return escapeMarkdown(domNode.textContent ?? "");
	}
	if (domNode.nodeType !== ELEMENT_NODE) {
		return "";
	}

	const element = node as DomElement;
	const children = Array.from(element.childNodes ?? [])
		.map(renderNode)
		.join("")
		.trim();
	const tag = element.tagName.toLowerCase();

	switch (tag) {
		case "h1":
			return `# ${children}\n\n`;
		case "h2":
			return `## ${children}\n\n`;
		case "h3":
			return `### ${children}\n\n`;
		case "h4":
			return `#### ${children}\n\n`;
		case "h5":
			return `##### ${children}\n\n`;
		case "h6":
			return `###### ${children}\n\n`;
		case "p":
			return `${children}\n\n`;
		case "br":
			return "\n";
		case "strong":
		case "b":
			return `**${children}**`;
		case "em":
		case "i":
			return `*${children}*`;
		case "code":
			return `\`${children}\``;
		case "pre":
			return `\`\`\`\n${element.textContent?.trim() ?? ""}\n\`\`\`\n\n`;
		case "blockquote":
			return `${children
				.split("\n")
				.map((line) => (line.trim() ? `> ${line}` : ">"))
				.join("\n")}\n\n`;
		case "ul":
			return `${Array.from(element.children ?? [])
				.map((child) => `- ${renderNode(child).trim()}`)
				.join("\n")}\n\n`;
		case "ol":
			return `${Array.from(element.children ?? [])
				.map((child, index) => `${index + 1}. ${renderNode(child).trim()}`)
				.join("\n")}\n\n`;
		case "li":
			return children;
		case "a": {
			const href = element.getAttribute("href");
			return href ? `[${children || href}](${href})` : children;
		}
		default:
			return children ? `${children}${["div", "section", "article"].includes(tag) ? "\n\n" : ""}` : "";
	}
}

export function htmlToText(html: string): string {
	const dom = createDom(html);
	return normalizeWhitespace(dom.window.document.body.textContent ?? "");
}

export function htmlToMarkdown(html: string): string {
	const dom = createDom(html);
	const body = dom.window.document.body;
	return normalizeWhitespace(Array.from(body.childNodes).map(renderNode).join(""));
}

export function extractReadableContent(
	html: string,
	url: string,
	extractMode: "markdown" | "text",
): { title: string; content: string; extractor: string } {
	const dom = createDom(html, url);
	const article = new Readability(dom.window.document).parse();
	if (!article) {
		const fallbackContent = extractMode === "text" ? htmlToText(html) : htmlToMarkdown(html);
		return {
			title: dom.window.document.title?.trim() ?? "",
			content: fallbackContent,
			extractor: extractMode === "text" ? "html-text" : "html-markdown",
		};
	}

	const articleContent = article.content ?? "";
	const content = extractMode === "text" ? htmlToText(articleContent) : htmlToMarkdown(articleContent);
	return {
		title: article.title?.trim() ?? "",
		content,
		extractor: extractMode === "text" ? "readability-text" : "readability-markdown",
	};
}
