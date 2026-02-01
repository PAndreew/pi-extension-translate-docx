import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";

const DOCUMENT_XML_PATH = "word/document.xml";

export interface DocxData {
	/** The raw XML string of word/document.xml */
	documentXml: string;
	/** The JSZip instance with all other files intact */
	zip: JSZip;
}

/**
 * Extract word/document.xml from a .docx file.
 * A .docx is a zip archive; we read the main document XML
 * and keep the zip open for later repacking.
 */
export async function extractDocxXml(inputPath: string): Promise<DocxData> {
	const buffer = await readFile(inputPath);
	const zip = await JSZip.loadAsync(buffer);

	const documentFile = zip.file(DOCUMENT_XML_PATH);
	if (!documentFile) {
		throw new Error(`No ${DOCUMENT_XML_PATH} found in ${inputPath}. Is this a valid .docx file?`);
	}

	const documentXml = await documentFile.async("string");
	return { documentXml, zip };
}

/**
 * Replace word/document.xml in the zip and write the result to outputPath.
 */
export async function repackDocx(
	zip: JSZip,
	translatedXml: string,
	outputPath: string,
): Promise<void> {
	zip.file(DOCUMENT_XML_PATH, translatedXml);

	const output = await zip.generateAsync({
		type: "nodebuffer",
		compression: "DEFLATE",
		compressionOptions: { level: 6 },
	});

	await writeFile(outputPath, output);
}
