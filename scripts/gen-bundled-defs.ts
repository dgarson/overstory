/**
 * Build-time script: generates src/agents/bundled-defs.ts by embedding
 * agents/*.md, templates/*.tmpl, and the package version as string constants.
 *
 * Run via: bun run scripts/gen-bundled-defs.ts
 * Called automatically by: make bundled-defs (and transitively: make build)
 *
 * Why string literals instead of new URL() / import.meta.dir?
 * In a Bun compiled binary, import.meta.dir resolves to the directory
 * containing the binary (e.g. /usr/local/bin), not the source tree.
 * Dynamic new URL() template literals are not detected by the bundler.
 * String constants embedded here are the only approach that works reliably.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const agentsDir = join(root, "agents");
const templatesDir = join(root, "templates");
const outFile = join(root, "src", "agents", "bundled-defs.ts");

const AGENT_FILES = [
	"scout.md",
	"builder.md",
	"reviewer.md",
	"lead.md",
	"merger.md",
	"supervisor.md",
	"coordinator.md",
	"monitor.md",
];

const TEMPLATE_FILES = ["hooks.json.tmpl", "overlay.md.tmpl", "CLAUDE.md.tmpl"];

const packageJson = (await Bun.file(join(root, "package.json")).json()) as { version: string };
const version: string = packageJson.version;

const lines: string[] = [
	"/**",
	" * Assets embedded as string constants at compile time.",
	" * AUTO-GENERATED — do not edit. Regenerate with: make bundled-defs",
	" * Sources: agents/*.md, templates/*.tmpl, package.json#version",
	" */",
	"",
];

// Agent definitions
lines.push("export const BUNDLED_AGENT_DEFS: Record<string, string> = {");
for (const fileName of AGENT_FILES) {
	const content = await Bun.file(join(agentsDir, fileName)).text();
	lines.push(`\t${JSON.stringify(fileName)}: ${JSON.stringify(content)},`);
}
lines.push("};", "");

// Templates
lines.push("export const BUNDLED_TEMPLATES: Record<string, string> = {");
for (const fileName of TEMPLATE_FILES) {
	const content = await Bun.file(join(templatesDir, fileName)).text();
	lines.push(`\t${JSON.stringify(fileName)}: ${JSON.stringify(content)},`);
}
lines.push("};", "");

// Version
lines.push(`export const BUNDLED_VERSION = ${JSON.stringify(version)};`, "");

await Bun.write(outFile, lines.join("\n"));
process.stdout.write(`Generated ${outFile} (v${version})\n`);
