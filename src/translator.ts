import {
	createAgentSession,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { ParagraphChunk } from "./xml-chunker.js";

export interface TranslateOptions {
	targetLanguage: string;
	sourceLanguage?: string;
	modelRegistry: ModelRegistry;
	model?: Model<any>;
	concurrency: number;
	batchSize?: number;
	signal?: AbortSignal;
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

/**
 * Translate a batch of chunks using a single agent session.
 */
async function translateBatch(
	batch: ParagraphChunk[],
	options: TranslateOptions,
): Promise<ParagraphChunk[]> {
	if (batch.length === 0) return [];

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
		// Return original chunks on failure to avoid data loss (though untranslated)
		return batch; 
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

	// Handle missing/unparseable chunks by reverting to original
	for (const chunk of batch) {
		if (!foundIds.has(chunk.index)) {
			// console.warn(`Chunk ${chunk.index} missing from translation output, reverting.`);
			results.push(chunk);
		}
	}

	return results;
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
	for (let i = 0; i < batches.length; i += options.concurrency) {
		if (options.signal?.aborted) {
			throw new Error("Translation aborted");
		}

		const currentBatches = batches.slice(i, i + options.concurrency);
		const batchResults = await Promise.all(
			currentBatches.map((batch) => translateBatch(batch, options)),
		);

		// Flatten batch results into main results array
		for (const batchResult of batchResults) {
			for (const translatedChunk of batchResult) {
				results[translatedChunk.index] = translatedChunk;
			}
		}
	}

	return results;
}
