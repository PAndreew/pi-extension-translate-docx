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
	signal?: AbortSignal;
}

const TRANSLATION_SYSTEM_PROMPT = `You are a document translator. Your task is to translate text while preserving all markup markers exactly.

Rules:
- Translate ONLY the human-readable text between markers
- Preserve ALL [RUN:nnn]...[/RUN:nnn] markers exactly — do not translate, reorder, or remove them
- Preserve ALL [TAG:nnn] markers exactly in their original positions
- Do not add any explanation, commentary, or extra text
- Output ONLY the translated result
- Maintain the same whitespace and line structure`;

/**
 * Translate a single chunk using a disposable agent session.
 */
async function translateSingleChunk(
	chunk: ParagraphChunk,
	options: TranslateOptions,
): Promise<ParagraphChunk> {
	if (!chunk.hasText || !chunk.simplifiedText.trim()) {
		return chunk;
	}

	const { session } = await createAgentSession({
		model: options.model,
		modelRegistry: options.modelRegistry,
		sessionManager: SessionManager.inMemory(),
		tools: [],
		thinkingLevel: "off",
	});

	let result = "";
	session.subscribe((event: any) => {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const parts = event.message.content;
			if (Array.isArray(parts)) {
				result = parts
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
			} else if (typeof parts === "string") {
				result = parts;
			}
		}
	});

	const langHint = options.sourceLanguage ? `from ${options.sourceLanguage} ` : "";
	const prompt =
		`${TRANSLATION_SYSTEM_PROMPT}\n\n` +
		`Translate the following ${langHint}to ${options.targetLanguage}:\n\n` +
		chunk.simplifiedText;

	await session.prompt(prompt);
	session.dispose();

	return {
		index: chunk.index,
		simplifiedText: result.trim() || chunk.simplifiedText,
		hasText: true,
	};
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

	// Separate translatable from pass-through chunks
	const toTranslate = chunks.filter((c) => c.hasText && c.simplifiedText.trim());
	const passThrough = chunks.filter((c) => !c.hasText || !c.simplifiedText.trim());

	// Copy pass-through chunks directly
	for (const chunk of passThrough) {
		results[chunk.index] = chunk;
	}

	// Translate in batches
	for (let i = 0; i < toTranslate.length; i += options.concurrency) {
		if (options.signal?.aborted) {
			throw new Error("Translation aborted");
		}

		const batch = toTranslate.slice(i, i + options.concurrency);
		const batchResults = await Promise.all(
			batch.map((chunk) => translateSingleChunk(chunk, options)),
		);

		for (const translated of batchResults) {
			results[translated.index] = translated;
		}
	}

	return results;
}
