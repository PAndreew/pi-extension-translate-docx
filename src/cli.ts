#!/usr/bin/env node

/**
 * CLI entry point for translate-docx.
 * Creates its own AuthStorage + ModelRegistry from ~/.pi/mom/auth.json,
 * then delegates to the shared translateDocx() orchestrator.
 */

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { translateDocx, terminateAllSessions } from "./translate.js";

function usage(): never {
	console.error(`Usage: translate-docx --input <file.docx> --output <file.docx> --lang <language> [options]

Options:
  --input, -i       Source .docx file (required)
  --output, -o      Output .docx file (required)
  --lang, -l        Target language, e.g. "German" (required)
  --source-lang     Source language (auto-detected if omitted)
  --concurrency     Max parallel translation requests (default: 5)
  --model           Model ID, e.g. "gemini-3-flash" (default: gemini-3-flash)
  --provider        Provider ID, e.g. "google-antigravity" (default: google-antigravity)
  --auth            Path to auth.json (default: ~/.pi/mom/auth.json)
  --help, -h        Show this help`);
	process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") usage();

		const flags: Record<string, string> = {
			"--input": "input", "-i": "input",
			"--output": "output", "-o": "output",
			"--lang": "lang", "-l": "lang",
			"--source-lang": "sourceLang",
			"--concurrency": "concurrency",
			"--model": "model",
			"--provider": "provider",
			"--auth": "auth",
		};

		const key = flags[arg];
		if (key && i + 1 < argv.length) {
			args[key] = argv[++i];
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (!args.input || !args.output || !args.lang) {
		console.error("Error: --input, --output, and --lang are required.\n");
		usage();
	}

	const authPath = args.auth ?? join(homedir(), ".pi", "mom", "auth.json");
	const providerId = args.provider ?? "google-antigravity";
	const modelId = args.model ?? "gemini-3-flash";
	const concurrency = args.concurrency ? parseInt(args.concurrency, 10) : 5;

	// Set up auth and model
	const authStorage = new AuthStorage(authPath);
	const modelRegistry = new ModelRegistry(authStorage);

	// Find model via registry (supports any provider, not just built-in KnownProvider types)
	const model = modelRegistry.find(providerId, modelId);
	if (!model) {
		console.error(`Error: Could not find model "${modelId}" from provider "${providerId}".`);
		console.error("Available models:", modelRegistry.getAll().map((m: any) => `${m.provider}/${m.id}`).join(", "));
		process.exit(1);
	}

	const apiKey = await authStorage.getApiKey(providerId);
	if (!apiKey) {
		console.error(`Error: No API key found for provider "${providerId}".`);
		console.error(`Expected auth file at: ${authPath}`);
		console.error("Run 'pi /login' with the appropriate provider first.");
		process.exit(1);
	}

	// Handle signals for graceful shutdown
	const controller = new AbortController();
	const signal = controller.signal;

	const handleSignal = () => {
		console.error("\nReceived signal, aborting translation...");
		controller.abort();
		terminateAllSessions();
		process.exit(1);
	};

	process.on("SIGINT", handleSignal);
	process.on("SIGTERM", handleSignal);

	try {
		// Run translation
		const result = await translateDocx({
			inputPath: args.input,
			outputPath: args.output,
			targetLanguage: args.lang,
			sourceLanguage: args.sourceLang,
			concurrency,
			modelRegistry,
			model,
			onProgress: (msg) => console.error(msg),
			signal,
		});

		// Output result as JSON on stdout for machine consumption
		console.log(JSON.stringify(result));
	} catch (error: any) {
		if (signal.aborted) {
			console.error("Translation aborted by user.");
			process.exit(1);
		}
		throw error;
	}
}

main().catch((err) => {
	console.error(`Fatal: ${err.message}`);
	process.exit(1);
});
