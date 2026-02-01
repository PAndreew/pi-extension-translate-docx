/**
 * XML chunking and tag replacement for Word document translation.
 *
 * Strategy:
 * 1. Find all <w:p> (paragraph) elements in the document XML
 * 2. Extract the text runs (<w:t>) from each paragraph
 * 3. Replace XML formatting tags with short [ID:nnn] markers
 * 4. After translation, restore the original tags using the ID map
 *
 * This lets the LLM translate plain text with simple markers
 * instead of wrestling with complex XML.
 */

/** A paragraph chunk ready for translation */
export interface ParagraphChunk {
	/** Index of this paragraph in the document */
	index: number;
	/** The simplified text with [ID:nnn] markers replacing XML tags */
	simplifiedText: string;
	/** Whether this paragraph has any translatable text */
	hasText: boolean;
}

/** Map from numeric ID to the original XML tag/fragment it replaced */
export type IdTagMap = Map<number, string>;

/**
 * Extract paragraph blocks from document XML.
 * Returns the raw XML of each <w:p>...</w:p> element.
 */
export function chunkParagraphs(documentXml: string): string[] {
	const paragraphs: string[] = [];
	const regex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(documentXml)) !== null) {
		paragraphs.push(match[0]);
	}

	return paragraphs;
}

/**
 * Replace XML tags within paragraph text runs with [ID:nnn] markers.
 *
 * Inside a <w:p>, text content lives in <w:r><w:t>...</w:t></w:r> runs.
 * Each run can have formatting properties (<w:rPr>) that we want to preserve
 * but not send to the LLM.
 *
 * We replace each <w:r>...<w:t>text</w:t></w:r> with just the text,
 * and store the surrounding XML structure keyed by ID.
 */
export function replaceTagsWithIds(paragraphs: string[]): {
	chunks: ParagraphChunk[];
	idTagMap: IdTagMap;
} {
	const idTagMap: IdTagMap = new Map();
	const chunks: ParagraphChunk[] = [];
	let nextId = 1;

	for (let i = 0; i < paragraphs.length; i++) {
		const para = paragraphs[i];

		// Extract text from <w:t> elements to check if there's anything to translate
		const textContent = extractTextContent(para);
		if (!textContent.trim()) {
			chunks.push({ index: i, simplifiedText: "", hasText: false });
			continue;
		}

		// Replace each run with a simplified form:
		// [ID:n]text[/ID:n] where n maps back to the run's XML wrapper
		let simplified = "";
		const runRegex = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
		let runMatch: RegExpExecArray | null;
		let lastIndex = 0;

		// Capture non-run content (paragraph properties, etc.) as-is via IDs
		while ((runMatch = runRegex.exec(para)) !== null) {
			// Content between runs (paragraph props, etc.)
			if (runMatch.index > lastIndex) {
				const between = para.slice(lastIndex, runMatch.index);
				if (between.trim()) {
					const id = nextId++;
					idTagMap.set(id, between);
					simplified += `[TAG:${id}]`;
				}
			}

			const runInner = runMatch[1];
			const textMatch = runInner.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/);

			if (textMatch) {
				// This run has text — extract it and store the XML wrapper
				const text = textMatch[1];
				const beforeText = runMatch[0].slice(0, runMatch[0].indexOf(textMatch[0]));
				const afterText = runMatch[0].slice(
					runMatch[0].indexOf(textMatch[0]) + textMatch[0].length,
				);
				// Store the full <w:t> element template (with attributes) for reconstruction
				// Positional replacement — simple .replace() breaks when text content
				// (e.g. a space) also appears inside the tag's attributes.
				const tFull = textMatch[0];
				const closingBracket = tFull.indexOf(">") + 1;
				const textStart = tFull.indexOf(textMatch[1], closingBracket);
				const tElementTemplate =
					tFull.slice(0, textStart) + "{{TEXT}}" + tFull.slice(textStart + textMatch[1].length);

				const id = nextId++;
				idTagMap.set(id, JSON.stringify({
					before: beforeText,
					after: afterText,
					tTemplate: tElementTemplate,
				}));
				simplified += `[RUN:${id}]${text}[/RUN:${id}]`;
			} else {
				// Run without text (e.g., images, breaks) — preserve as opaque tag
				const id = nextId++;
				idTagMap.set(id, runMatch[0]);
				simplified += `[TAG:${id}]`;
			}

			lastIndex = runMatch.index + runMatch[0].length;
		}

		// Trailing content after last run
		if (lastIndex < para.length) {
			const trailing = para.slice(lastIndex);
			if (trailing.trim()) {
				const id = nextId++;
				idTagMap.set(id, trailing);
				simplified += `[TAG:${id}]`;
			}
		}

		chunks.push({ index: i, simplifiedText: simplified, hasText: true });
	}

	return { chunks, idTagMap };
}

/**
 * Extract plain text content from a paragraph XML string.
 */
function extractTextContent(paragraphXml: string): string {
	const texts: string[] = [];
	const regex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(paragraphXml)) !== null) {
		texts.push(match[1]);
	}

	return texts.join("");
}

/**
 * Reconstruct the full document XML by replacing original paragraphs
 * with translated ones, restoring all XML tags from the ID map.
 */
export function reconstructXml(
	originalDocumentXml: string,
	translatedChunks: ParagraphChunk[],
	idTagMap: IdTagMap,
): string {
	// Build a map of paragraph index -> translated simplified text
	const translatedByIndex = new Map<number, string>();
	for (const chunk of translatedChunks) {
		if (chunk.hasText) {
			translatedByIndex.set(chunk.index, chunk.simplifiedText);
		}
	}

	// Replace paragraphs in the original XML
	let paragraphIndex = 0;
	const result = originalDocumentXml.replace(
		/<w:p[\s>][\s\S]*?<\/w:p>/g,
		(originalParagraph) => {
			const translated = translatedByIndex.get(paragraphIndex);
			paragraphIndex++;

			if (translated === undefined) {
				return originalParagraph; // No translation for this paragraph
			}

			return restoreParagraphXml(translated, idTagMap);
		},
	);

	return result;
}

/**
 * Convert a simplified translated paragraph back to full XML.
 * Replaces [RUN:n]text[/RUN:n] and [TAG:n] markers with original XML.
 */
function restoreParagraphXml(simplified: string, idTagMap: IdTagMap): string {
	let xml = simplified;

	// Restore [RUN:n]translated text[/RUN:n] markers
	xml = xml.replace(/\[RUN:(\d+)\]([\s\S]*?)\[\/RUN:\1\]/g, (_match, idStr, translatedText) => {
		const id = parseInt(idStr, 10);
		const stored = idTagMap.get(id);
		if (!stored) return translatedText;

		try {
			const { before, after, tTemplate } = JSON.parse(stored);
			const tElement = tTemplate.replace("{{TEXT}}", escapeXml(translatedText));
			return before + tElement + after;
		} catch {
			return translatedText;
		}
	});

	// Restore [TAG:n] markers (opaque XML fragments)
	xml = xml.replace(/\[TAG:(\d+)\]/g, (_match, idStr) => {
		const id = parseInt(idStr, 10);
		return idTagMap.get(id) ?? "";
	});

	return xml;
}

/**
 * Escape special XML characters in translated text.
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
