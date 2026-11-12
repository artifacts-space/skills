#!/usr/bin/env node
// Checks every skills/<name>/SKILL.md: YAML frontmatter with `name` and
// `description`, and `name` equal to its folder. Then checks the plugin
// package (scripts/plugin-rules.mjs). Plain Node, no dependencies.
// Usage: node scripts/check-skills.mjs [--release]
// --release also fails while the plugin's demo video URL is a placeholder.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginPackage, PLUGIN_DIR } from "./plugin-rules.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(root, "skills");
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/** Removes matching single or double quotes around a YAML scalar. */
function unquote(value) {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted ? quoted[2] : value;
}

/** Reads top-level `key: value` pairs, including `>` and `|` block scalars. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (raw !== ">" && raw !== "|" && raw !== ">-" && raw !== "|-") {
      fields[key] = unquote(raw.trim());
      continue;
    }
    const block = [];
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
      index += 1;
      block.push(lines[index].trim());
    }
    fields[key] = block.join(raw.startsWith(">") ? " " : "\n");
  }
  return fields;
}

/** Returns the problems with one skill folder, or an empty list. */
function checkSkill(folder) {
  const file = join(skillsDir, folder, "SKILL.md");
  if (!existsSync(file)) return [`skills/${folder}: missing SKILL.md`];
  const fields = parseFrontmatter(readFileSync(file, "utf8"));
  if (!fields) return [`skills/${folder}/SKILL.md: missing YAML frontmatter between --- lines`];
  const problems = [];
  const { name, description } = fields;
  if (!name) problems.push("missing `name`");
  else if (name !== folder) problems.push(`\`name\` is "${name}" but the folder is "${folder}"`);
  else if (!NAME_PATTERN.test(name) || name.length > MAX_NAME) problems.push(`\`name\` must be lowercase words joined by hyphens, at most ${MAX_NAME} characters`);
  if (!description) problems.push("missing `description`");
  else if (description.length > MAX_DESCRIPTION) problems.push(`\`description\` is ${description.length} characters; keep it under ${MAX_DESCRIPTION}`);
  return problems.map((problem) => `skills/${folder}/SKILL.md: ${problem}`);
}

function main() {
  const problems = [];
  if (existsSync(join(root, "SKILL.md"))) problems.push("SKILL.md at the repository root hides the skills/ folder from skills.sh; remove it");
  const folders = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  if (folders.length === 0) problems.push("no skills found under skills/");
  for (const folder of folders) problems.push(...checkSkill(folder));
  problems.push(...checkPluginPackage(root, { release: process.argv.includes("--release") }));

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log(`✓ ${folders.length} skill${folders.length === 1 ? "" : "s"} valid: ${folders.join(", ")}`);
  console.log(`✓ plugin package valid: ${PLUGIN_DIR}, gemini-extension.json, .cursor-plugin/marketplace.json${process.argv.includes("--release") ? " (release)" : ""}`);
}

main();
