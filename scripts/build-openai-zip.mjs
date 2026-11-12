#!/usr/bin/env node
// Builds the ZIP you upload at platform.openai.com/plugins from
// plugins/artifacts-space/. Runs the release checks first, so it refuses to
// build while the demo video URL is still the placeholder.
//
// The ZIP holds the plugin's files at its root, without the Claude manifest
// (.claude-plugin/) and the Claude MCP file (.mcp.json). Its mcp.json also
// declares OAuth with a Client ID Metadata Document, as OpenAI's MCP
// authentication reference describes; the repository copy stays plain so it
// matches the Agent Plugins schema that Cursor checks.
//
// Usage: node scripts/build-openai-zip.mjs [--draft] [--out <folder>]
//   --draft  build before the demo video exists; leaves demo_recording_url out
//   --out    output folder, default dist/ (git-ignored)
// Needs the `zip` command (preinstalled on macOS and GitHub's Ubuntu runners).

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginPackage, DEMO_PLACEHOLDER, PLUGIN_DIR } from "./plugin-rules.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const LEFT_OUT = new Set([".claude-plugin", ".mcp.json", ".DS_Store"]);
const OPENAI_AUTH = { type: "oauth", client: { mode: "cimd" } };
/** Printed after every build: the check the person submitting must run, because of the client bug noted in stage(). */
const INSTALL_CHECK =
  "Before you submit: install this ZIP in a current Codex or ChatGPT build and check that the artifacts MCP server loads and lists its tools (some builds drop it: https://github.com/openai/codex/issues/53658).";

/**
 * Reads `--draft` and `--out <folder>` from the command line.
 * Returns `{ error }` when `--out` has no folder after it, or a flag in its place.
 */
function parseArgs(argv) {
  const draft = argv.includes("--draft");
  const outIndex = argv.indexOf("--out");
  if (outIndex < 0) return { draft, out: join(root, "dist") };
  const out = argv[outIndex + 1];
  if (!out || out.startsWith("--")) return { error: `--out needs a folder after it, as in --out dist/ (got ${out ? `"${out}"` : "nothing"})` };
  return { draft, out: resolve(out) };
}

/** Copies the plugin into a staging folder and writes the OpenAI-only changes. */
function stage(stageDir, draft) {
  cpSync(join(root, PLUGIN_DIR), stageDir, { recursive: true, filter: (source) => !LEFT_OUT.has(basename(source)) });
  const manifestPath = join(stageDir, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const review = manifest.extensions["com.openai"].review;
  if (draft && review.demo_recording_url === DEMO_PLACEHOLDER) delete review.demo_recording_url;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const mcpPath = join(stageDir, "mcp.json");
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  // The packaged file keeps "$schema" although the Agent Plugins MCP schema
  // closes each server to type/url/headers, so `extensions` is outside it.
  // OpenAI's plugin docs (developers.openai.com/codex/plugins/build, "Use a
  // registered OAuth client") show exactly this: the Agent Plugins $schema and
  // extensions["com.openai"].auth in one mcp.json. The schema also requires
  // "$schema", so dropping it would break the schema a second way.
  // Known client bug, open when checked on 2026-11-12: some Codex and ChatGPT
  // builds reject the server's `extensions` key ("unknown field `extensions`")
  // and drop the MCP server (https://github.com/openai/codex/issues/53658).
  // The ZIP still uploads, but the plugin then shows no tools, so main()
  // prints INSTALL_CHECK after every build.
  for (const server of Object.values(mcp.mcpServers)) server.extensions = { "com.openai": { auth: OPENAI_AUTH } };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  return manifest.version;
}

function main() {
  const { draft, out, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`✗ ${error}`);
    process.exit(1);
  }
  const problems = checkPluginPackage(root, { release: !draft });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(draft ? "Fix these, then build again." : "Fix these, or add --draft to build without the demo video.");
    process.exit(1);
  }
  const work = mkdtempSync(join(tmpdir(), "artifacts-space-openai-"));
  try {
    const stageDir = join(work, "plugin");
    const version = stage(stageDir, draft);
    mkdirSync(out, { recursive: true });
    const zipPath = join(out, `artifacts-space-openai-${version}${draft ? "-draft" : ""}.zip`);
    rmSync(zipPath, { force: true });
    execFileSync("zip", ["-r", "-X", "-q", zipPath, "."], { cwd: stageDir, stdio: "inherit" });
    console.log(`✓ ${zipPath}${draft ? " (draft: no demo video URL)" : ""}`);
    console.log(INSTALL_CHECK);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
