#!/usr/bin/env node
// Builds the ZIP you upload at platform.openai.com/plugins from
// plugins/artifacts-space/. Runs the release checks first, so it refuses to
// build while the demo video URL is still the placeholder.
//
// The ZIP holds the plugin's files at its root, without the Claude manifest
// (.claude-plugin/) and the Claude MCP file (.mcp.json). Its mcp.json is the
// repository's file byte for byte, with no sign-in settings: a current Codex
// build drops a server whose mcp.json carries fields outside the Agent Plugins
// schema (such as extensions["com.openai"].auth), and finds OAuth on its own
// from the server's WWW-Authenticate header. Upstream issue, still open on
// 2026-11-12: https://github.com/openai/codex/issues/53658
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
/** Printed after every build: the check to run before a submission. */
const INSTALL_CHECK = "Before you submit: install this ZIP in a current Codex or ChatGPT build and check that the artifacts MCP server loads, signs in, and lists its tools.";

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

/** Copies the plugin into a staging folder; only plugin.json changes, and only for a draft. */
function stage(stageDir, draft) {
  cpSync(join(root, PLUGIN_DIR), stageDir, { recursive: true, filter: (source) => !LEFT_OUT.has(basename(source)) });
  const manifestPath = join(stageDir, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const review = manifest.extensions["com.openai"].review;
  if (draft && review.demo_recording_url === DEMO_PLACEHOLDER) delete review.demo_recording_url;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
