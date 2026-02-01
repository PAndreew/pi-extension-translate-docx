import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { extractDocxXml, repackDocx } from "./docx.js";
import { chunkParagraphs, replaceTagsWithIds, reconstructXml } from "./xml-chunker.js";
import { translateChunksInParallel } from "./translator.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "translate_docx",
		label: "Translate DOCX",
		description:
			"Translate a Word document (.docx) while preserving all formatting. " +
			"Extracts the document XML, translates paragraph text via parallel sub-agents, " +
			"and reconstructs the document with original formatting intact.",
		parameters: Type.Object({
			input_path: Type.String({ description: "Absolute path to the source .docx file" }),
			output_path: Type.String({ description: "Absolute path for the translated .docx output" }),
			target_language: Type.String({ description: "Target language, e.g. 'German', 'French', 'Japanese'" }),
			source_language: Type.Optional(
				Type.String({ description: "Source language (auto-detected if omitted)" }),
			),
			concurrency: Type.Optional(
				Type.Number({ description: "Max parallel translation requests (default: 5)", minimum: 1, maximum: 20 }),
			),
		}),

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const { input_path, output_path, target_language, source_language } = params;
			const concurrency = params.concurrency ?? 5;

			// Step 1: Extract XML from .docx
			if (onUpdate) onUpdate({ type: "text", text: "Extracting document XML..." } as any);
			const { documentXml, zip } = await extractDocxXml(input_path);

			// Step 2: Chunk paragraphs and replace tags with IDs
			if (onUpdate) onUpdate({ type: "text", text: "Chunking paragraphs..." } as any);
			const paragraphs = chunkParagraphs(documentXml);
			const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

			if (chunks.length === 0) {
				return {
					content: [{ type: "text", text: "No translatable text found in document." }],
					details: { chunksTranslated: 0 },
				};
			}

			// Step 3: Translate chunks in parallel via sub-agents
			if (onUpdate) {
				onUpdate({ type: "text", text: `Translating ${chunks.length} chunks to ${target_language}...` } as any);
			}
			const translatedChunks = await translateChunksInParallel(chunks, {
				targetLanguage: target_language,
				sourceLanguage: source_language,
				modelRegistry: ctx.modelRegistry,
				model: ctx.model,
				concurrency,
				signal,
			});

			// Step 4: Reconstruct XML and repack .docx
			if (onUpdate) onUpdate({ type: "text", text: "Reconstructing document..." } as any);
			const translatedXml = reconstructXml(documentXml, translatedChunks, idTagMap);
			await repackDocx(zip, translatedXml, output_path);

			return {
				content: [
					{
						type: "text",
						text: `Translated document saved to ${output_path}\n` +
							`  Chunks translated: ${chunks.length}\n` +
							`  Target language: ${target_language}`,
					},
				],
				details: {
					chunksTranslated: chunks.length,
					targetLanguage: target_language,
					outputPath: output_path,
				},
			};
		},
	});
}
