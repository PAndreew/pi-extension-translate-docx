import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the translate module.
 *
 * Since validateXml is not exported, we test it indirectly through translateDocx.
 * We mock the docx, xml-chunker, and translator modules to isolate the orchestrator logic.
 */

// Mock the translator module (LLM calls)
vi.mock("./translator.js", () => ({
	translateChunksInParallel: vi.fn(),
	terminateAllSessions: vi.fn(),
}));

// Mock the docx module (file I/O)
vi.mock("./docx.js", () => ({
	extractDocxXml: vi.fn(),
	repackDocx: vi.fn(),
}));

import { translateDocx } from "./translate.js";
import { extractDocxXml, repackDocx } from "./docx.js";
import { translateChunksInParallel } from "./translator.js";
import type { ParagraphChunk } from "./xml-chunker.js";

const mockExtractDocxXml = vi.mocked(extractDocxXml);
const mockRepackDocx = vi.mocked(repackDocx);
const mockTranslateChunks = vi.mocked(translateChunksInParallel);

const dummyModelRegistry = {} as any;

function makeSimpleDocXml(text: string): string {
	return `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>`;
}

describe("translateDocx", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("orchestrates extract -> chunk -> translate -> reconstruct -> repack", async () => {
		const originalXml = makeSimpleDocXml("Hello");
		const mockZip = {} as any;

		mockExtractDocxXml.mockResolvedValue({ documentXml: originalXml, zip: mockZip });
		mockRepackDocx.mockResolvedValue(undefined);

		// The translator returns chunks with translated text
		mockTranslateChunks.mockImplementation(async (chunks) => {
			return chunks.map((c: ParagraphChunk) => ({
				...c,
				simplifiedText: c.simplifiedText.replace("Hello", "Hallo"),
			}));
		});

		const result = await translateDocx({
			inputPath: "/input.docx",
			outputPath: "/output.docx",
			targetLanguage: "German",
			modelRegistry: dummyModelRegistry,
		});

		expect(result.outputPath).toBe("/output.docx");
		expect(result.targetLanguage).toBe("German");
		expect(result.chunksTranslated).toBe(1);

		expect(mockExtractDocxXml).toHaveBeenCalledWith("/input.docx");
		expect(mockRepackDocx).toHaveBeenCalledWith(
			mockZip,
			expect.stringContaining("Hallo"),
			"/output.docx",
		);
	});

	it("handles document with no translatable text", async () => {
		// Paragraph with only properties, no w:t elements
		const emptyXml = `<w:body><w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p></w:body>`;
		const mockZip = {} as any;

		mockExtractDocxXml.mockResolvedValue({ documentXml: emptyXml, zip: mockZip });
		mockRepackDocx.mockResolvedValue(undefined);

		const result = await translateDocx({
			inputPath: "/input.docx",
			outputPath: "/output.docx",
			targetLanguage: "German",
			modelRegistry: dummyModelRegistry,
		});

		expect(result.chunksTranslated).toBe(0);
		// Should still produce output (copy of original)
		expect(mockRepackDocx).toHaveBeenCalledWith(mockZip, emptyXml, "/output.docx");
		// Should not call translator
		expect(mockTranslateChunks).not.toHaveBeenCalled();
	});

	it("calls onProgress callbacks", async () => {
		const originalXml = makeSimpleDocXml("Hello");
		const mockZip = {} as any;
		const progressMessages: string[] = [];

		mockExtractDocxXml.mockResolvedValue({ documentXml: originalXml, zip: mockZip });
		mockRepackDocx.mockResolvedValue(undefined);
		mockTranslateChunks.mockImplementation(async (chunks) => chunks);

		await translateDocx({
			inputPath: "/input.docx",
			outputPath: "/output.docx",
			targetLanguage: "French",
			modelRegistry: dummyModelRegistry,
			onProgress: (msg) => progressMessages.push(msg),
		});

		expect(progressMessages.length).toBeGreaterThan(0);
		expect(progressMessages.some((m) => m.includes("Extracting"))).toBe(true);
		expect(progressMessages.some((m) => m.includes("Chunking"))).toBe(true);
		expect(progressMessages.some((m) => m.includes("Translating"))).toBe(true);
		expect(progressMessages.some((m) => m.includes("Done"))).toBe(true);
	});

	it("escapes XML special characters in translated text without corrupting output", async () => {
		const originalXml = makeSimpleDocXml("Hello");
		const mockZip = {} as any;

		mockExtractDocxXml.mockResolvedValue({ documentXml: originalXml, zip: mockZip });
		mockRepackDocx.mockResolvedValue(undefined);

		// Translator injects XML-like characters — escapeXml should neutralize them
		mockTranslateChunks.mockImplementation(async (chunks) => {
			return chunks.map((c: ParagraphChunk) => ({
				...c,
				simplifiedText: c.simplifiedText.replace("Hello", "A & B < C"),
			}));
		});

		const result = await translateDocx({
			inputPath: "/input.docx",
			outputPath: "/output.docx",
			targetLanguage: "German",
			modelRegistry: dummyModelRegistry,
		});

		expect(result.chunksTranslated).toBe(1);
		// The repacked XML should contain the escaped version
		const repackedXml = mockRepackDocx.mock.calls[0][1];
		expect(repackedXml).toContain("A &amp; B &lt; C");
	});

	it("passes concurrency and batchSize to translator", async () => {
		const originalXml = makeSimpleDocXml("Hello");
		const mockZip = {} as any;

		mockExtractDocxXml.mockResolvedValue({ documentXml: originalXml, zip: mockZip });
		mockRepackDocx.mockResolvedValue(undefined);
		mockTranslateChunks.mockImplementation(async (chunks) => chunks);

		await translateDocx({
			inputPath: "/input.docx",
			outputPath: "/output.docx",
			targetLanguage: "German",
			modelRegistry: dummyModelRegistry,
			concurrency: 3,
			batchSize: 25,
		});

		expect(mockTranslateChunks).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({
				concurrency: 3,
				batchSize: 25,
				targetLanguage: "German",
			}),
		);
	});

	it("uses default concurrency and batchSize when not specified", async () => {
		const originalXml = makeSimpleDocXml("Hello");
		const mockZip = {} as any;

		mockExtractDocxXml.mockResolvedValue({ documentXml: originalXml, zip: mockZip });
		mockRepackDocx.mockResolvedValue(undefined);
		mockTranslateChunks.mockImplementation(async (chunks) => chunks);

		await translateDocx({
			inputPath: "/input.docx",
			outputPath: "/output.docx",
			targetLanguage: "German",
			modelRegistry: dummyModelRegistry,
		});

		expect(mockTranslateChunks).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({
				concurrency: 5,
				batchSize: 50,
			}),
		);
	});
});
