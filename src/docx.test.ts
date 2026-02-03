import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractDocxXml, repackDocx } from "./docx.js";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DOCUMENT_XML_PATH = "word/document.xml";

/** Create a minimal valid .docx buffer in memory. */
async function createTestDocx(documentXml: string): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(DOCUMENT_XML_PATH, documentXml);
	// Add minimal content types (required for a real .docx but not for our tests)
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
	);
	return zip.generateAsync({ type: "nodebuffer" }) as Promise<Buffer>;
}

/** Write a buffer to a temp file and return the path. */
async function writeTempDocx(buffer: Buffer, name: string): Promise<string> {
	const path = join(tmpdir(), `test-${name}-${Date.now()}.docx`);
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, buffer);
	return path;
}

describe("extractDocxXml", () => {
	it("extracts document XML from a valid .docx", async () => {
		const xml = `<w:document><w:body><w:p><w:r><w:t>Test</w:t></w:r></w:p></w:body></w:document>`;
		const buffer = await createTestDocx(xml);
		const path = await writeTempDocx(buffer, "extract");

		try {
			const result = await extractDocxXml(path);
			expect(result.documentXml).toBe(xml);
			expect(result.zip).toBeInstanceOf(JSZip);
		} finally {
			await unlink(path).catch(() => {});
		}
	});

	it("throws when file has no word/document.xml", async () => {
		const zip = new JSZip();
		zip.file("other.xml", "<root/>");
		const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
		const path = await writeTempDocx(buffer, "no-doc");

		try {
			await expect(extractDocxXml(path)).rejects.toThrow(/No word\/document.xml found/);
		} finally {
			await unlink(path).catch(() => {});
		}
	});

	it("throws when file does not exist", async () => {
		await expect(extractDocxXml("/nonexistent/file.docx")).rejects.toThrow();
	});

	it("preserves other files in the zip", async () => {
		const xml = `<w:document/>`;
		const zip = new JSZip();
		zip.file(DOCUMENT_XML_PATH, xml);
		zip.file("word/styles.xml", "<w:styles/>");
		zip.file("word/media/image1.png", "fake-image-data");
		const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
		const path = await writeTempDocx(buffer, "preserve");

		try {
			const result = await extractDocxXml(path);
			expect(result.documentXml).toBe(xml);

			// Check other files are still in the zip
			const stylesFile = result.zip.file("word/styles.xml");
			expect(stylesFile).not.toBeNull();
			const stylesContent = await stylesFile!.async("string");
			expect(stylesContent).toBe("<w:styles/>");

			const imageFile = result.zip.file("word/media/image1.png");
			expect(imageFile).not.toBeNull();
		} finally {
			await unlink(path).catch(() => {});
		}
	});
});

describe("repackDocx", () => {
	it("replaces document XML and writes valid .docx", async () => {
		const originalXml = `<w:document><w:body><w:p><w:r><w:t>Original</w:t></w:r></w:p></w:body></w:document>`;
		const translatedXml = `<w:document><w:body><w:p><w:r><w:t>Translated</w:t></w:r></w:p></w:body></w:document>`;

		const buffer = await createTestDocx(originalXml);
		const inputPath = await writeTempDocx(buffer, "repack-in");
		const outputPath = join(tmpdir(), `test-repack-out-${Date.now()}.docx`);

		try {
			const { zip } = await extractDocxXml(inputPath);
			await repackDocx(zip, translatedXml, outputPath);

			// Read back the output and verify
			const outputBuffer = await readFile(outputPath);
			const outputZip = await JSZip.loadAsync(outputBuffer);
			const docFile = outputZip.file(DOCUMENT_XML_PATH);
			expect(docFile).not.toBeNull();

			const content = await docFile!.async("string");
			expect(content).toBe(translatedXml);
		} finally {
			await unlink(inputPath).catch(() => {});
			await unlink(outputPath).catch(() => {});
		}
	});

	it("preserves other files during repack", async () => {
		const xml = `<w:document/>`;
		const zip = new JSZip();
		zip.file(DOCUMENT_XML_PATH, xml);
		zip.file("word/styles.xml", "<w:styles><w:style/></w:styles>");
		const buffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
		const inputPath = await writeTempDocx(buffer, "repack-preserve-in");
		const outputPath = join(tmpdir(), `test-repack-preserve-out-${Date.now()}.docx`);

		try {
			const { zip: loadedZip } = await extractDocxXml(inputPath);
			const newXml = `<w:document><w:body/></w:document>`;
			await repackDocx(loadedZip, newXml, outputPath);

			const outputBuffer = await readFile(outputPath);
			const outputZip = await JSZip.loadAsync(outputBuffer);

			// Document XML should be replaced
			const docContent = await outputZip.file(DOCUMENT_XML_PATH)!.async("string");
			expect(docContent).toBe(newXml);

			// Styles should be preserved
			const stylesContent = await outputZip.file("word/styles.xml")!.async("string");
			expect(stylesContent).toBe("<w:styles><w:style/></w:styles>");
		} finally {
			await unlink(inputPath).catch(() => {});
			await unlink(outputPath).catch(() => {});
		}
	});
});

describe("end-to-end: extract -> modify -> repack", () => {
	it("produces a valid .docx with modified content", async () => {
		const originalXml = [
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
			`<w:body>`,
			`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`,
			`</w:body>`,
			`</w:document>`,
		].join("");

		const buffer = await createTestDocx(originalXml);
		const inputPath = await writeTempDocx(buffer, "e2e-in");
		const outputPath = join(tmpdir(), `test-e2e-out-${Date.now()}.docx`);

		try {
			// Extract
			const { documentXml, zip } = await extractDocxXml(inputPath);
			expect(documentXml).toBe(originalXml);

			// Modify
			const modifiedXml = documentXml.replace("Hello World", "Hallo Welt");

			// Repack
			await repackDocx(zip, modifiedXml, outputPath);

			// Verify
			const { documentXml: finalXml } = await extractDocxXml(outputPath);
			expect(finalXml).toContain("Hallo Welt");
			expect(finalXml).not.toContain("Hello World");
		} finally {
			await unlink(inputPath).catch(() => {});
			await unlink(outputPath).catch(() => {});
		}
	});
});
