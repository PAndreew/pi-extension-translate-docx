import {
	createAgentSession,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { ParagraphChunk } from "./xml-chunker.js";

const MAX_RETRIES = 2;

export interface TranslateOptions {
	targetLanguage: string;
	sourceLanguage?: string;
	modelRegistry: ModelRegistry;
	model?: Model<any>;
	concurrency: number;
	batchSize?: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

const TRANSLATION_SYSTEM_PROMPT = `You are a document translator. Your task is to translate text while preserving all markup markers exactly.

Input Format:
The input contains multiple paragraphs, each wrapped in <p id="n">...</p> tags.

Rules:
- Translate the text INSIDE each <p> tag
- PRESERVE the <p id="n">...</p> wrapper tags and their IDs exactly
- Preserve ALL [RUN:nnn]...[/RUN:nnn] markers exactly — do not translate, reorder, or remove them
- Preserve ALL [TAG:nnn] markers exactly inside the text
- Do not add any explanation or commentary
- Output ONLY the translated result, maintaining the XML-like structure`;

const activeSessions = new Set<any>();

export function terminateAllSessions() {
	for (const session of activeSessions) {
		try {
			session.dispose();
		} catch (e) {
			// ignore
		}
	}
	activeSessions.clear();
}

interface BatchResult {
	translated: ParagraphChunk[];
	missing: ParagraphChunk[];
}

/**
 * Translate a batch of chunks using a single agent session.
 * Returns both successfully translated chunks and any that were
 * missing from the LLM response.
 */
async function translateBatch(
	batch: ParagraphChunk[],
	options: TranslateOptions,
): Promise<BatchResult> {
	if (batch.length === 0) return { translated: [], missing: [] };

	const { session } = await createAgentSession({
		model: options.model,
		modelRegistry: options.modelRegistry,
		sessionManager: SessionManager.inMemory(),
		tools: [],
		thinkingLevel: "off",
	});

	activeSessions.add(session);

	let resultText = "";
	session.subscribe((event: any) => {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const parts = event.message.content;
			if (Array.isArray(parts)) {
				resultText = parts
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
			} else if (typeof parts === "string") {
				resultText = parts;
			}
		}
	});

	const langHint = options.sourceLanguage ? `from ${options.sourceLanguage} ` : "";
	
	// Construct batched input
	const inputContent = batch
		.map((c) => `<p id="${c.index}">${c.simplifiedText}</p>`)
		.join("\n");

	const prompt =
		`${TRANSLATION_SYSTEM_PROMPT}\n\n` +
		`Translate the following ${langHint}to ${options.targetLanguage}:\n\n` +
		inputContent;

	try {
		await session.prompt(prompt);
	} catch (e) {
		console.error("Batch translation failed:", e);
		return { translated: [], missing: batch };
	} finally {
		activeSessions.delete(session);
		session.dispose();
	}

	// Parse results
	const results: ParagraphChunk[] = [];
	const regex = /<p id="(\d+)">([\s\S]*?)<\/p>/g;
	let match: RegExpExecArray | null;
	const foundIds = new Set<number>();

	while ((match = regex.exec(resultText)) !== null) {
		const id = parseInt(match[1], 10);
		const translatedText = match[2].trim();
		const original = batch.find((c) => c.index === id);
		
		if (original) {
			results.push({
				...original,
				simplifiedText: translatedText || original.simplifiedText,
				hasText: true,
			});
			foundIds.add(id);
		}
	}

	// Collect chunks missing from LLM response
	const missing: ParagraphChunk[] = [];
	for (const chunk of batch) {
		if (!foundIds.has(chunk.index)) {
			missing.push(chunk);
		}
	}

	return { translated: results, missing };
}

/**
 * Translate all chunks in parallel with bounded concurrency.
 * Only chunks with hasText=true are sent to the LLM.
 */
export async function translateChunksInParallel(
	chunks: ParagraphChunk[],
	options: TranslateOptions,
): Promise<ParagraphChunk[]> {
	const results: ParagraphChunk[] = new Array(chunks.length);
	const batchSize = options.batchSize ?? 50;

	// Separate translatable from pass-through chunks
	const toTranslate = chunks.filter((c) => c.hasText && c.simplifiedText.trim());
	const passThrough = chunks.filter((c) => !c.hasText || !c.simplifiedText.trim());

	// Copy pass-through chunks directly
	for (const chunk of passThrough) {
		results[chunk.index] = chunk;
	}

	// Group into batches
	const batches: ParagraphChunk[][] = [];
	for (let i = 0; i < toTranslate.length; i += batchSize) {
		batches.push(toTranslate.slice(i, i + batchSize));
	}

	// Process batches with concurrency
	let allMissing: ParagraphChunk[] = [];

	for (let i = 0; i < batches.length; i += options.concurrency) {
		if (options.signal?.aborted) {
			throw new Error("Translation aborted");
		}

		const currentBatches = batches.slice(i, i + options.concurrency);
		const batchResults = await Promise.all(
			currentBatches.map((batch) => translateBatch(batch, options)),
		);

		for (const { translated, missing } of batchResults) {
			for (const chunk of translated) {
				results[chunk.index] = chunk;
			}
			allMissing.push(...missing);
		}
	}

	// Retry missing chunks
	for (let retry = 1; retry <= MAX_RETRIES && allMissing.length > 0; retry++) {
		if (options.signal?.aborted) {
			throw new Error("Translation aborted");
		}

		const missingIds = allMissing.map((c) => c.index).join(", ");
		options.onProgress?.(
			`Retry ${retry}/${MAX_RETRIES}: ${allMissing.length} chunks missing (ids: ${missingIds}), retranslating...`,
		);
		console.warn(
			`Retry ${retry}/${MAX_RETRIES}: chunks [${missingIds}] missing from translation output, retrying...`,
		);

		// Retry missing chunks in smaller batches (one per batch) to maximise success
		const retryBatches: ParagraphChunk[][] = allMissing.map((c) => [c]);
		const stillMissing: ParagraphChunk[] = [];

		for (let i = 0; i < retryBatches.length; i += options.concurrency) {
			if (options.signal?.aborted) {
				throw new Error("Translation aborted");
			}

			const currentBatches = retryBatches.slice(i, i + options.concurrency);
			const retryResults = await Promise.all(
				currentBatches.map((batch) => translateBatch(batch, options)),
			);

			for (const { translated, missing } of retryResults) {
				for (const chunk of translated) {
					results[chunk.index] = chunk;
				}
				stillMissing.push(...missing);
			}
		}

		allMissing = stillMissing;
	}

	// If chunks are still missing after all retries, revert to originals and warn
	if (allMissing.length > 0) {
		const missingIds = allMissing.map((c) => c.index).join(", ");
		options.onProgress?.(
			`Warning: ${allMissing.length} chunks could not be translated after ${MAX_RETRIES} retries (ids: ${missingIds}). Keeping original text.`,
		);
		console.warn(
			`${allMissing.length} chunks could not be translated after ${MAX_RETRIES} retries (ids: ${missingIds}). Keeping original text.`,
		);
		for (const chunk of allMissing) {
			results[chunk.index] = chunk;
		}
	}

	return results;
}
