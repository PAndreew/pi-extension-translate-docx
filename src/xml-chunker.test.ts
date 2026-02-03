import { describe, it, expect } from "vitest";
import {
	chunkParagraphs,
	replaceTagsWithIds,
	reconstructXml,
	type ParagraphChunk,
	type IdTagMap,
} from "./xml-chunker.js";

describe("chunkParagraphs", () => {
	it("extracts simple paragraphs", () => {
		const xml = `<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body>`;
		const result = chunkParagraphs(xml);
		expect(result).toHaveLength(2);
		expect(result[0]).toContain("Hello");
		expect(result[1]).toContain("World");
	});

	it("returns empty array when no paragraphs", () => {
		const xml = `<w:body><w:sectPr/></w:body>`;
		expect(chunkParagraphs(xml)).toEqual([]);
	});

	it("handles paragraphs with attributes", () => {
		const xml = `<w:body><w:p w:rsidR="00A1"><w:r><w:t>Text</w:t></w:r></w:p></w:body>`;
		const result = chunkParagraphs(xml);
		expect(result).toHaveLength(1);
		expect(result[0]).toContain("Text");
		expect(result[0]).toContain('w:rsidR="00A1"');
	});

	it("handles empty paragraphs", () => {
		const xml = `<w:body><w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p></w:body>`;
		const result = chunkParagraphs(xml);
		expect(result).toHaveLength(1);
	});

	it("handles multiple runs in one paragraph", () => {
		const xml = `<w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p></w:body>`;
		const result = chunkParagraphs(xml);
		expect(result).toHaveLength(1);
		expect(result[0]).toContain("Hello ");
		expect(result[0]).toContain("World");
	});
});

describe("replaceTagsWithIds", () => {
	it("replaces text runs with RUN markers", () => {
		const paragraphs = [`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`];
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].hasText).toBe(true);
		expect(chunks[0].simplifiedText).toMatch(/\[RUN:\d+\]Hello\[\/RUN:\d+\]/);
		expect(idTagMap.size).toBeGreaterThan(0);
	});

	it("marks empty paragraphs as no-text", () => {
		const paragraphs = [`<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>`];
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].hasText).toBe(false);
		expect(chunks[0].simplifiedText).toBe("");
	});

	it("marks whitespace-only paragraphs as no-text", () => {
		const paragraphs = [`<w:p><w:r><w:t>   </w:t></w:r></w:p>`];
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].hasText).toBe(false);
	});

	it("preserves paragraph properties as TAG markers", () => {
		const paragraphs = [
			`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Centered</w:t></w:r></w:p>`,
		];
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks[0].hasText).toBe(true);
		expect(chunks[0].simplifiedText).toMatch(/\[TAG:\d+\]/);
		expect(chunks[0].simplifiedText).toContain("Centered");
	});

	it("handles multiple runs preserving order", () => {
		const paragraphs = [
			`<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>World</w:t></w:r></w:p>`,
		];
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks[0].hasText).toBe(true);
		const text = chunks[0].simplifiedText;
		const helloPos = text.indexOf("Hello ");
		const worldPos = text.indexOf("World");
		expect(helloPos).toBeLessThan(worldPos);
	});

	it("handles runs without text as TAG markers", () => {
		const paragraphs = [
			`<w:p><w:r><w:t>Text</w:t></w:r><w:r><w:br/></w:r></w:p>`,
		];
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks[0].hasText).toBe(true);
		// The break run should be a TAG, not a RUN
		expect(chunks[0].simplifiedText).toMatch(/\[TAG:\d+\]/);
		expect(chunks[0].simplifiedText).toMatch(/\[RUN:\d+\]Text\[\/RUN:\d+\]/);
	});

	it("handles w:t with xml:space preserve attribute", () => {
		const paragraphs = [
			`<w:p><w:r><w:t xml:space="preserve"> Hello </w:t></w:r></w:p>`,
		];
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks[0].hasText).toBe(true);
		expect(chunks[0].simplifiedText).toContain(" Hello ");
	});

	it("assigns correct indices to chunks", () => {
		const paragraphs = [
			`<w:p><w:r><w:t>First</w:t></w:r></w:p>`,
			`<w:p><w:pPr/></w:p>`,
			`<w:p><w:r><w:t>Third</w:t></w:r></w:p>`,
		];
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks).toHaveLength(3);
		expect(chunks[0].index).toBe(0);
		expect(chunks[1].index).toBe(1);
		expect(chunks[2].index).toBe(2);
	});

	it("stores run XML structure in idTagMap as JSON", () => {
		const paragraphs = [
			`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r></w:p>`,
		];
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		// Find the RUN id from the simplified text
		const runMatch = chunks[0].simplifiedText.match(/\[RUN:(\d+)\]/);
		expect(runMatch).not.toBeNull();

		const id = parseInt(runMatch![1], 10);
		const stored = idTagMap.get(id);
		expect(stored).toBeDefined();

		// Should be valid JSON with before/after/tTemplate
		const parsed = JSON.parse(stored!);
		expect(parsed).toHaveProperty("before");
		expect(parsed).toHaveProperty("after");
		expect(parsed).toHaveProperty("tTemplate");
		expect(parsed.tTemplate).toContain("{{TEXT}}");
	});
});

describe("reconstructXml", () => {
	it("round-trips simple text through tag replacement and reconstruction", () => {
		const documentXml = `<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		// Simulate no translation (identity)
		const result = reconstructXml(documentXml, chunks, idTagMap);
		expect(result).toBe(documentXml);
	});

	it("applies translated text correctly", () => {
		const documentXml = `<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		// Simulate translation: replace "Hello" with "Hallo" in the simplified text
		const translatedChunks = chunks.map((c) => ({
			...c,
			simplifiedText: c.simplifiedText.replace("Hello", "Hallo"),
		}));

		const result = reconstructXml(documentXml, translatedChunks, idTagMap);
		expect(result).toContain("Hallo");
		expect(result).not.toContain("Hello");
		expect(result).toContain("<w:t>");
		expect(result).toContain("</w:t>");
	});

	it("preserves formatting through round-trip", () => {
		const documentXml = `<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r></w:p></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const translatedChunks = chunks.map((c) => ({
			...c,
			simplifiedText: c.simplifiedText.replace("Bold", "Fett"),
		}));

		const result = reconstructXml(documentXml, translatedChunks, idTagMap);
		expect(result).toContain("Fett");
		expect(result).toContain("<w:b/>");
		expect(result).toContain("<w:rPr>");
	});

	it("leaves non-text paragraphs unchanged", () => {
		const documentXml =
			`<w:body>` +
			`<w:p><w:r><w:t>Text</w:t></w:r></w:p>` +
			`<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>` +
			`</w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const result = reconstructXml(documentXml, chunks, idTagMap);
		expect(result).toContain('<w:spacing w:after="200"/>');
	});

	it("handles multiple paragraphs with translation", () => {
		const documentXml =
			`<w:body>` +
			`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>` +
			`<w:p><w:r><w:t>World</w:t></w:r></w:p>` +
			`</w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const translatedChunks = chunks.map((c) => ({
			...c,
			simplifiedText: c.simplifiedText.replace("Hello", "Hallo").replace("World", "Welt"),
		}));

		const result = reconstructXml(documentXml, translatedChunks, idTagMap);
		expect(result).toContain("Hallo");
		expect(result).toContain("Welt");
		expect(result).not.toContain("Hello");
		expect(result).not.toContain("World");
	});

	it("escapes XML special characters in translated text", () => {
		const documentXml = `<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const translatedChunks = chunks.map((c) => ({
			...c,
			simplifiedText: c.simplifiedText.replace("Hello", "A & B < C"),
		}));

		const result = reconstructXml(documentXml, translatedChunks, idTagMap);
		expect(result).toContain("A &amp; B &lt; C");
	});

	it("preserves paragraph properties through translation", () => {
		const documentXml =
			`<w:body>` +
			`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>` +
			`</w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const translatedChunks = chunks.map((c) => ({
			...c,
			simplifiedText: c.simplifiedText.replace("Title", "Titel"),
		}));

		const result = reconstructXml(documentXml, translatedChunks, idTagMap);
		expect(result).toContain("Titel");
		expect(result).toContain('<w:jc w:val="center"/>');
	});

	it("handles multiple runs in a paragraph", () => {
		const documentXml =
			`<w:body>` +
			`<w:p>` +
			`<w:r><w:t>Hello </w:t></w:r>` +
			`<w:r><w:rPr><w:b/></w:rPr><w:t>World</w:t></w:r>` +
			`</w:p>` +
			`</w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const translatedChunks = chunks.map((c) => ({
			...c,
			simplifiedText: c.simplifiedText.replace("Hello ", "Hallo ").replace("World", "Welt"),
		}));

		const result = reconstructXml(documentXml, translatedChunks, idTagMap);
		expect(result).toContain("Hallo ");
		expect(result).toContain("Welt");
		expect(result).toContain("<w:b/>");
	});
});

describe("edge cases", () => {
	it("handles empty document XML", () => {
		const documentXml = `<w:body></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		expect(paragraphs).toEqual([]);

		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);
		expect(chunks).toEqual([]);

		const result = reconstructXml(documentXml, chunks, idTagMap);
		expect(result).toBe(documentXml);
	});

	it("handles paragraph with only non-text runs", () => {
		const documentXml = `<w:body><w:p><w:r><w:br/></w:r></w:p></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks } = replaceTagsWithIds(paragraphs);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].hasText).toBe(false);
	});

	it("preserves content outside paragraphs", () => {
		const documentXml = `<w:body><w:sectPr><w:pgSz/></w:sectPr><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const result = reconstructXml(documentXml, chunks, idTagMap);
		expect(result).toContain("<w:sectPr><w:pgSz/></w:sectPr>");
	});

	it("handles w:t with xml:space preserve through round-trip", () => {
		const documentXml = `<w:body><w:p><w:r><w:t xml:space="preserve"> Spaced </w:t></w:r></w:p></w:body>`;
		const paragraphs = chunkParagraphs(documentXml);
		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		const result = reconstructXml(documentXml, chunks, idTagMap);
		expect(result).toContain('xml:space="preserve"');
		expect(result).toContain(" Spaced ");
	});

	it("handles realistic Word XML structure", () => {
		const documentXml = [
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
			`<w:body>`,
			`<w:p w:rsidR="00A1" w:rsidRDefault="00A1">`,
			`<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>`,
			`<w:r w:rsidRPr="00B2"><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Chapter One</w:t></w:r>`,
			`</w:p>`,
			`<w:p w:rsidR="00C3">`,
			`<w:r><w:t xml:space="preserve">This is </w:t></w:r>`,
			`<w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>`,
			`<w:r><w:t xml:space="preserve"> text.</w:t></w:r>`,
			`</w:p>`,
			`</w:body>`,
			`</w:document>`,
		].join("");

		const paragraphs = chunkParagraphs(documentXml);
		expect(paragraphs).toHaveLength(2);

		const { chunks, idTagMap } = replaceTagsWithIds(paragraphs);

		// Translate
		const translatedChunks = chunks.map((c) => ({
			...c,
			simplifiedText: c.simplifiedText
				.replace("Chapter One", "Kapitel Eins")
				.replace("This is ", "Das ist ")
				.replace("italic", "kursiv")
				.replace(" text.", " Text."),
		}));

		const result = reconstructXml(documentXml, translatedChunks, idTagMap);

		// Translated text present
		expect(result).toContain("Kapitel Eins");
		expect(result).toContain("Das ist ");
		expect(result).toContain("kursiv");
		expect(result).toContain(" Text.");

		// Formatting preserved
		expect(result).toContain("<w:b/>");
		expect(result).toContain("<w:i/>");
		expect(result).toContain('<w:sz w:val="28"/>');
		expect(result).toContain('<w:pStyle w:val="Heading1"/>');
		expect(result).toContain('xml:space="preserve"');
	});
});
