/**
 * Shared translation orchestrator.
 * Used by both the extension entry point and the CLI binary.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { extractDocxXml, repackDocx } from "./docx.js";
import { chunkParagraphs, replaceTagsWithIds, reconstructXml } from "./xml-chunker.js";
import { translateChunksInParallel } from "./translator.js";

/**
 * Basic XML well-formedness check. Verifies that every opening tag has
 * a matching closing tag and vice versa. Throws on mismatches so we
 * never produce a corrupt .docx.
 */
function validateXml(xml: string): void {
	const tagStack: string[] = [];
	const tagRegex = /<(\/?)([a-zA-Z0-9:]+)([^>]*?)(\/?)>/g;
	let match: RegExpExecArray | null;

	while ((match = tagRegex.exec(xml)) !== null) {
		const [, isClosing, tagName, , isSelfClosing] = match;
		if (isSelfClosing) continue;
		if (isClosing) {
			const expected = tagStack.pop();
			if (expected !== tagName) {
				const pos = match.index;
				const context = xml.slice(Math.max(0, pos - 80), Math.min(xml.length, pos + 80));
				throw new Error(
					`Malformed XML: closing </${tagName}> but expected </${expected ?? "?"}> near position ${pos}\nContext: ...${context}...`,
				);
			}
		} else {
			tagStack.push(tagName);
		}
	}

	if (tagStack.length > 0) {
		throw new Error(`Malformed XML: unclosed tags: ${tagStack.join(", ")}`);
	}
}

export interface TranslateDocxOptions {
	inputPath: string;
	outputPath: string;
	targetLanguage: string;
	sourceLanguage?: string;
	concurrency?: number;
	modelRegistry: ModelRegistry;
	model?: Model<any>;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface TranslateDocxResult {
	outputPath: string;
	chunksTranslated: number;
	targetLanguage: string;
}

export async function translateDocx(options: TranslateDocxOptions): Promise<TranslateDocxResult> {
	const {
		inputPath,
		outputPath,
		targetLanguage,
		sourceLanguage,
		modelRegistry,
		model,
		signal,
		onProgress,
	} = options;
	const concurrency = options.concurrency ?? 5;

	// Step 1: Extract XML from .docx
	onProgress?.("Extracting document XML...");
	const { documentXml, zip } = await extractDocxXml(inputPath);

	// Step 2: Chunk paragraphs and replace tags with IDs
	onProgress?.("Chunking paragraphs...");
	const paragraphs = chunkParagraphs(documentXml);
	const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

	if (chunks.length === 0 || !chunks.some((c) => c.hasText)) {
		onProgress?.("No translatable text found.");
		// Still produce an output file (copy of original)
		await repackDocx(zip, documentXml, outputPath);
		return { outputPath, chunksTranslated: 0, targetLanguage };
	}

	const translatableCount = chunks.filter((c) => c.hasText).length;

	// Step 3: Translate chunks in parallel via sub-agents
	onProgress?.(`Translating ${translatableCount} chunks to ${targetLanguage}...`);
	const translatedChunks = await translateChunksInParallel(chunks, {
		targetLanguage,
		sourceLanguage,
		modelRegistry,
		model,
		concurrency,
		signal,
	});

	// Step 4: Reconstruct XML and repack .docx
	onProgress?.("Reconstructing document...");
	const translatedXml = reconstructXml(documentXml, translatedChunks, idTagMap);

	// Validate the XML is well-formed before repacking
	validateXml(translatedXml);

	await repackDocx(zip, translatedXml, outputPath);

	onProgress?.(`Done. Translated ${translatableCount} chunks to ${targetLanguage}.`);
	return { outputPath, chunksTranslated: translatableCount, targetLanguage };
}
