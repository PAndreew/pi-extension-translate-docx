import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { translateDocx } from "./translate.js";

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
			batch_size: Type.Optional(
				Type.Number({ description: "Number of paragraphs per translation batch (default: 50)", minimum: 1, maximum: 200 }),
			),
		}),

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const result = await translateDocx({
				inputPath: params.input_path,
				outputPath: params.output_path,
				targetLanguage: params.target_language,
				sourceLanguage: params.source_language,
				concurrency: params.concurrency,
				// @ts-ignore
				batchSize: params.batch_size,
				modelRegistry: ctx.modelRegistry,
				model: ctx.model,
				signal,
				onProgress: onUpdate
					? (msg) => onUpdate({ type: "text", text: msg } as any)
					: undefined,
			});

			return {
				content: [
					{
						type: "text",
						text: `Translated document saved to ${result.outputPath}\n` +
							`  Chunks translated: ${result.chunksTranslated}\n` +
							`  Target language: ${result.targetLanguage}`,
					},
				],
				details: result,
			};
		},
	});
}
