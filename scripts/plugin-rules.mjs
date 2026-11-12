// Checks the plugin package in plugins/artifacts-space/ and the manifests that
// point at it: the Agent Plugins manifest with its OpenAI listing, the Claude
// plugin manifest, both MCP files, the Cursor marketplace file, and
// gemini-extension.json. Plain Node, no dependencies.
// Used by scripts/check-skills.mjs and scripts/build-openai-zip.mjs.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export const PLUGIN_DIR = "plugins/artifacts-space";
export const PLUGIN_NAME = "artifacts-space";
export const MCP_URL = "https://artifacts.space/api/mcp";
export const DEMO_PLACEHOLDER = "REPLACE_WITH_DEMO_VIDEO_URL";

const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SEMVER = /^\d+\.\d+\.\d+$/;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"]);
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_README_WORDS = 40;

const AGENT_PLUGIN_KEYS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
const AUTHOR_KEYS = new Set(["name", "email", "url"]);
const OPENAI_KEYS = new Set(["interface", "onboardingSkill", "review", "publication"]);
const OPENAI_URL_FIELDS = ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"];
const CLAUDE_KEYS = new Set(["$schema", "name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]);
const CLAUDE_URL_FIELDS = ["documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"];
const GEMINI_KEYS = new Set(["name", "version", "description", "mcpServers", "contextFileName", "excludeTools", "migratedTo", "plan", "settings", "themes"]);
const FORBIDDEN_REVIEW_KEYS = ["test_credentials", "reviewer_instructions"];

// Shapes of real credentials. Built so that tool names such as
// `artifacts_restore_version` and the `YOUR_TOKEN` placeholder never match.
const TOKEN_PATTERNS = [
  ["artifacts.space token", /\bartifacts_(?:oat_)?(?=[\w-]*\d)(?=[\w-]*[A-Z])[\w-]{24,}/],
  ["OpenAI-style key", /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["literal bearer token", /Bearer\s+(?!\$|YOUR_TOKEN\b)[A-Za-z0-9._~+/=-]{20,}/],
];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;

/** Reads and parses a JSON file, recording a problem instead of throwing. */
function readJson(root, path, problems) {
  const file = join(root, path);
  if (!existsSync(file)) {
    problems.push(`${path}: missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${path}: not valid JSON (${error.message})`);
    return null;
  }
}

/** Returns the width and height of a PNG file, or null when it is not a PNG. */
export function pngSize(file) {
  const bytes = readFileSync(file);
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** True when a URL is https and on artifacts.space or this repository. */
export function isAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.hostname === "artifacts.space") return true;
  return url.hostname === "github.com" && /^\/artifacts-space\/skills(?:\/|$)/.test(url.pathname);
}

/** Lists every string in a JSON value that looks like a URL, with its key. */
function urlsIn(value, key = "") {
  if (typeof value === "string") return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? [{ key, value }] : [];
  if (Array.isArray(value)) return value.flatMap((item) => urlsIn(item, key));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([childKey, child]) => urlsIn(child, childKey));
}

/** Checks the hosts of every URL in a manifest; `$schema` and the demo video are exempt. */
function checkUrls(path, json, problems) {
  for (const { key, value } of urlsIn(json)) {
    if (key === "$schema" || key === "demo_recording_url") continue;
    if (!isAllowedUrl(value)) problems.push(`${path}: ${key} "${value}" must be an https URL on artifacts.space or github.com/artifacts-space/skills`);
  }
}

/** Checks a `./`-prefixed path that must name a file inside the plugin folder. */
function checkPluginPath(pluginRoot, path, label, value, problems, { dotSlash = true } = {}) {
  if (!isText(value)) {
    problems.push(`${path}: missing ${label}`);
    return null;
  }
  if (dotSlash && !value.startsWith("./")) problems.push(`${path}: ${label} must start with ./`);
  const target = resolve(pluginRoot, value);
  if (value.split(/[\\/]/).includes("..") || !(target + sep).startsWith(resolve(pluginRoot) + sep)) {
    problems.push(`${path}: ${label} must stay inside ${PLUGIN_DIR}`);
    return null;
  }
  if (!existsSync(target)) {
    problems.push(`${path}: ${label} "${value}" does not exist`);
    return null;
  }
  return target;
}

/** Checks that an icon is a square PNG within the size limits the directories publish. */
function checkIcon(path, label, file, problems) {
  if (!file) return;
  const size = pngSize(file);
  if (!size) {
    problems.push(`${path}: ${label} must be a PNG file`);
    return;
  }
  if (size.width !== size.height) problems.push(`${path}: ${label} is ${size.width}x${size.height}; it must be square`);
  if (size.width < 48 || size.width > 4096) problems.push(`${path}: ${label} is ${size.width} px wide; use 48 to 4096 px`);
  if (lstatSync(file).size > MAX_IMAGE_BYTES) problems.push(`${path}: ${label} is over 5 MiB`);
}

function checkLength(path, label, value, max, problems) {
  if (!isText(value)) problems.push(`${path}: missing ${label}`);
  else if (value.length > max) problems.push(`${path}: ${label} is ${value.length} characters; keep it to ${max}`);
}

function checkKeys(path, object, allowed, problems, where = "") {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) problems.push(`${path}: unknown field ${where}${key}`);
  }
}

function checkAuthor(path, author, problems) {
  if (!isObject(author) || author.name !== "Webrenew LLC") problems.push(`${path}: author.name must be "Webrenew LLC"`);
  if (isObject(author)) checkKeys(path, author, AUTHOR_KEYS, problems, "author.");
}

function checkTestCases(path, testCases, problems) {
  const positive = testCases?.positive;
  const negative = testCases?.negative;
  if (!Array.isArray(positive) || positive.length !== 5) problems.push(`${path}: review.test_cases.positive needs exactly 5 cases`);
  if (!Array.isArray(negative) || negative.length !== 3) problems.push(`${path}: review.test_cases.negative needs exactly 3 cases`);
  for (const [index, item] of (Array.isArray(positive) ? positive : []).entries()) {
    for (const field of ["description", "prompt", "tools_triggered", "expected_behavior"]) {
      if (!isText(item?.[field])) problems.push(`${path}: positive test case ${index + 1} needs a text \`${field}\``);
    }
  }
  for (const [index, item] of (Array.isArray(negative) ? negative : []).entries()) {
    for (const field of ["description", "prompt"]) {
      if (!isText(item?.[field])) problems.push(`${path}: negative test case ${index + 1} needs a text \`${field}\``);
    }
  }
}

function checkDemoUrl(path, value, release, problems) {
  if (value === DEMO_PLACEHOLDER) {
    if (release) problems.push(`${path}: review.demo_recording_url is still ${DEMO_PLACEHOLDER}; put the demo video's https URL there before a release`);
    return;
  }
  let url = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:") problems.push(`${path}: review.demo_recording_url must be an https URL or ${DEMO_PLACEHOLDER}`);
}

/** Checks the OpenAI listing under extensions["com.openai"]. */
function checkOpenAiListing(path, pluginRoot, openai, release, problems) {
  if (!isObject(openai)) {
    problems.push(`${path}: missing extensions["com.openai"]`);
    return;
  }
  checkKeys(path, openai, OPENAI_KEYS, problems, 'extensions["com.openai"].');
  const ui = openai.interface;
  if (!isObject(ui)) {
    problems.push(`${path}: missing extensions["com.openai"].interface`);
    return;
  }
  checkLength(path, "interface.displayName", ui.displayName, 30, problems);
  checkLength(path, "interface.shortDescription", ui.shortDescription, 30, problems);
  checkLength(path, "interface.longDescription", ui.longDescription, 4000, problems);
  checkLength(path, "interface.developerName", ui.developerName, 80, problems);
  if (ui.developerName !== "Webrenew LLC") problems.push(`${path}: interface.developerName must be "Webrenew LLC"`);
  if (ui.category !== "Productivity") problems.push(`${path}: interface.category must be "Productivity"`);
  const capabilities = Array.isArray(ui.capabilities) ? ui.capabilities : [];
  if (capabilities.length > 20 || capabilities.some((item) => !isText(item) || item.length > 120)) problems.push(`${path}: interface.capabilities takes at most 20 labels of up to 120 characters`);
  for (const field of OPENAI_URL_FIELDS) {
    if (!isText(ui[field])) problems.push(`${path}: missing interface.${field}`);
  }
  const prompts = Array.isArray(ui.defaultPrompt) ? ui.defaultPrompt : [ui.defaultPrompt].filter(Boolean);
  if (prompts.length > 3 || prompts.some((item) => !isText(item) || item.length > 128)) problems.push(`${path}: interface.defaultPrompt takes at most 3 prompts of up to 128 characters`);
  for (const field of ["brandColor", "brandColorDark"]) {
    if (ui[field] !== undefined && !HEX_COLOR.test(ui[field])) problems.push(`${path}: interface.${field} must be #RRGGBB`);
  }
  checkIcon(path, "interface.logo", checkPluginPath(pluginRoot, path, "interface.logo", ui.logo, problems), problems);
  checkIcon(path, "interface.composerIcon", checkPluginPath(pluginRoot, path, "interface.composerIcon", ui.composerIcon, problems), problems);
  if (openai.onboardingSkill !== undefined) {
    checkPluginPath(pluginRoot, path, "onboardingSkill", openai.onboardingSkill, problems);
    if (!/^\.\/skills\/[^/]+\/SKILL\.md$/.test(openai.onboardingSkill)) problems.push(`${path}: onboardingSkill must name ./skills/<name>/SKILL.md`);
  }
  const review = openai.review;
  if (!isObject(review)) {
    problems.push(`${path}: missing extensions["com.openai"].review`);
    return;
  }
  for (const key of FORBIDDEN_REVIEW_KEYS) {
    if (key in review) problems.push(`${path}: review.${key} is not allowed in the package; enter it in the submission portal`);
  }
  checkTestCases(path, review.test_cases, problems);
  checkDemoUrl(path, review.demo_recording_url, release, problems);
  if (!isText(openai.publication?.release_notes)) problems.push(`${path}: missing publication.release_notes`);
}

/** Checks the portable Agent Plugins manifest at the plugin root. */
function checkAgentManifest(root, release, problems) {
  const path = `${PLUGIN_DIR}/plugin.json`;
  const json = readJson(root, path, problems);
  if (!isObject(json)) return null;
  checkKeys(path, json, AGENT_PLUGIN_KEYS, problems);
  if (json.$schema !== AGENT_PLUGIN_SCHEMA) problems.push(`${path}: $schema must be ${AGENT_PLUGIN_SCHEMA}`);
  if (json.name !== PLUGIN_NAME) problems.push(`${path}: name must be "${PLUGIN_NAME}"`);
  checkLength(path, "description", json.description, 1024, problems);
  checkAuthor(path, json.author, problems);
  if (json.license !== "MIT") problems.push(`${path}: license must be "MIT"`);
  checkUrls(path, json, problems);
  checkOpenAiListing(path, join(root, PLUGIN_DIR), json.extensions?.["com.openai"], release, problems);
  return json;
}

/** Checks the single remote server shared by every MCP file. */
function checkServers(path, servers, type, urlKey, problems, extraKeys = []) {
  if (!isObject(servers) || Object.keys(servers).length !== 1 || !isObject(servers.artifacts)) {
    problems.push(`${path}: mcpServers must hold exactly one server, "artifacts"`);
    return;
  }
  const server = servers.artifacts;
  const allowed = new Set([urlKey, ...(type ? ["type"] : []), ...extraKeys]);
  checkKeys(path, server, allowed, problems, "mcpServers.artifacts.");
  if (type && server.type !== type) problems.push(`${path}: mcpServers.artifacts.type must be "${type}"`);
  if (server[urlKey] !== MCP_URL) problems.push(`${path}: mcpServers.artifacts.${urlKey} must be ${MCP_URL}`);
}

function checkMcpFiles(root, problems) {
  const portablePath = `${PLUGIN_DIR}/mcp.json`;
  const portable = readJson(root, portablePath, problems);
  if (isObject(portable)) {
    checkKeys(portablePath, portable, new Set(["$schema", "mcpServers"]), problems);
    if (portable.$schema !== AGENT_MCP_SCHEMA) problems.push(`${portablePath}: $schema must be ${AGENT_MCP_SCHEMA}`);
    checkServers(portablePath, portable.mcpServers, "streamable-http", "url", problems);
  }
  const claudePath = `${PLUGIN_DIR}/.mcp.json`;
  const claude = readJson(root, claudePath, problems);
  if (isObject(claude)) {
    checkKeys(claudePath, claude, new Set(["mcpServers"]), problems);
    checkServers(claudePath, claude.mcpServers, "http", "url", problems);
  }
}

/** Checks the Claude plugin manifest in .claude-plugin/. */
function checkClaudeManifest(root, problems) {
  const path = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
  const json = readJson(root, path, problems);
  if (!isObject(json)) return null;
  checkKeys(path, json, CLAUDE_KEYS, problems);
  if (json.name !== PLUGIN_NAME) problems.push(`${path}: name must be "${PLUGIN_NAME}"`);
  if (!isText(json.displayName)) problems.push(`${path}: missing displayName`);
  if (!isText(json.description)) problems.push(`${path}: missing description`);
  checkAuthor(path, json.author, problems);
  if (json.license !== "MIT") problems.push(`${path}: license must be "MIT"`);
  for (const field of CLAUDE_URL_FIELDS) {
    if (!isText(json[field])) problems.push(`${path}: missing ${field}`);
  }
  checkIcon(path, "icon", checkPluginPath(join(root, PLUGIN_DIR), path, "icon", json.icon, problems), problems);
  checkUrls(path, json, problems);
  return json;
}

/** Checks gemini-extension.json at the repository root. */
function checkGeminiManifest(root, problems) {
  const path = "gemini-extension.json";
  const json = readJson(root, path, problems);
  if (!isObject(json)) return null;
  checkKeys(path, json, GEMINI_KEYS, problems);
  if (json.name !== PLUGIN_NAME) problems.push(`${path}: name must be "${PLUGIN_NAME}"`);
  if (!isText(json.description)) problems.push(`${path}: missing description`);
  checkServers(path, json.mcpServers, null, "httpUrl", problems);
  if (json.contextFileName !== undefined && !existsSync(join(root, json.contextFileName))) problems.push(`${path}: contextFileName "${json.contextFileName}" does not exist`);
  checkUrls(path, json, problems);
  return json;
}

/** Checks the Cursor marketplace file that points Cursor at the plugin folder. */
function checkCursorMarketplace(root, problems) {
  const path = ".cursor-plugin/marketplace.json";
  const json = readJson(root, path, problems);
  if (!isObject(json)) return null;
  if (json.name !== PLUGIN_NAME) problems.push(`${path}: name must be "${PLUGIN_NAME}"`);
  if (json.owner?.name !== "Webrenew LLC") problems.push(`${path}: owner.name must be "Webrenew LLC"`);
  const entries = Array.isArray(json.plugins) ? json.plugins : [];
  if (entries.length !== 1) {
    problems.push(`${path}: plugins must list exactly one plugin`);
    return null;
  }
  const [entry] = entries;
  if (entry.name !== PLUGIN_NAME) problems.push(`${path}: plugins[0].name must be "${PLUGIN_NAME}"`);
  if (entry.source !== PLUGIN_DIR) problems.push(`${path}: plugins[0].source must be "${PLUGIN_DIR}"`);
  const logo = checkPluginPath(join(root, PLUGIN_DIR), path, "plugins[0].logo", entry.logo, problems, { dotSlash: false });
  checkIcon(path, "plugins[0].logo", logo, problems);
  checkUrls(path, json, problems);
  return entry;
}

/** Lists every file under a folder, relative to it, without following links. */
function listFiles(folder, base = folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) return [relative(base, full), ...listFiles(full, base)];
    return [relative(base, full)];
  });
}

/** The plugin's skill folders must be byte-for-byte copies of skills/<name>. */
function checkSkillCopies(root, problems) {
  const pluginSkills = join(root, PLUGIN_DIR, "skills");
  const names = existsSync(pluginSkills) ? readdirSync(pluginSkills, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  if (!names.includes(PLUGIN_NAME)) problems.push(`${PLUGIN_DIR}/skills/${PLUGIN_NAME}: missing; copy skills/${PLUGIN_NAME} there`);
  for (const name of names) {
    const source = join(root, "skills", name);
    const copy = join(pluginSkills, name);
    if (!existsSync(source)) {
      problems.push(`${PLUGIN_DIR}/skills/${name}: no matching skills/${name} to copy from`);
      continue;
    }
    const sourceFiles = new Set(listFiles(source));
    const copyFiles = new Set(listFiles(copy));
    for (const file of new Set([...sourceFiles, ...copyFiles])) {
      const label = `${PLUGIN_DIR}/skills/${name}/${file.split(sep).join("/")}`;
      if (!sourceFiles.has(file)) problems.push(`${label}: not in skills/${name}; remove it or add it there`);
      else if (!copyFiles.has(file)) problems.push(`${label}: missing; copy it from skills/${name}`);
      else if (lstatSync(join(source, file)).isFile() && !readFileSync(join(source, file)).equals(readFileSync(join(copy, file)))) {
        problems.push(`${label}: differs from skills/${name}; copy it again with cp -R skills/${name} ${PLUGIN_DIR}/skills/`);
      }
    }
  }
}

/** Checks every file in the plugin folder: no links or system files, sizes, and no tokens. */
function checkPluginFiles(root, problems) {
  const pluginRoot = join(root, PLUGIN_DIR);
  for (const file of listFiles(pluginRoot)) {
    const full = join(pluginRoot, file);
    const label = `${PLUGIN_DIR}/${file.split(sep).join("/")}`;
    const stat = lstatSync(full);
    if (file.split(sep).some((part) => SYSTEM_FILES.has(part))) problems.push(`${label}: remove this system file`);
    if (stat.isSymbolicLink()) problems.push(`${label}: symbolic links are not allowed; commit a regular file`);
    if (!stat.isFile()) continue;
    const isImage = IMAGE_EXTENSIONS.has(extname(file).toLowerCase());
    if (!isImage && stat.size > MAX_TEXT_BYTES) problems.push(`${label}: over 256 KiB`);
    if (isImage && stat.size > MAX_IMAGE_BYTES) problems.push(`${label}: over 5 MiB`);
  }
}

/** Returns the token-like strings in a text, as "rule on line N". */
export function findTokens(text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    for (const [rule, pattern] of TOKEN_PATTERNS) {
      if (pattern.test(line)) findings.push(`${rule} on line ${index + 1}`);
    }
  });
  return findings;
}

function checkNoTokens(root, problems) {
  const files = [
    ...listFiles(join(root, PLUGIN_DIR)).map((file) => join(PLUGIN_DIR, file)),
    "gemini-extension.json",
    ".cursor-plugin/marketplace.json",
  ];
  for (const file of files) {
    const full = join(root, file);
    if (!existsSync(full) || !lstatSync(full).isFile() || IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    for (const finding of findTokens(readFileSync(full, "utf8"))) problems.push(`${file.split(sep).join("/")}: looks like a real credential (${finding}); use YOUR_TOKEN or $ARTIFACTS_SPACE_TOKEN`);
  }
}

/** Counts README words outside fenced code blocks. */
export function readmeWords(text) {
  return text.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

function checkReadmeAndLicense(root, problems) {
  const readme = join(root, PLUGIN_DIR, "README.md");
  if (!existsSync(readme)) problems.push(`${PLUGIN_DIR}/README.md: missing`);
  else if (readmeWords(readFileSync(readme, "utf8")) < MIN_README_WORDS) problems.push(`${PLUGIN_DIR}/README.md: needs at least ${MIN_README_WORDS} words outside code blocks`);
  const license = join(root, PLUGIN_DIR, "LICENSE");
  if (!existsSync(license)) problems.push(`${PLUGIN_DIR}/LICENSE: missing; copy LICENSE there`);
  else if (!readFileSync(license).equals(readFileSync(join(root, "LICENSE")))) problems.push(`${PLUGIN_DIR}/LICENSE: differs from LICENSE`);
}

/** Versions and descriptions must agree across every manifest. */
function checkAgreement(manifests, problems) {
  const present = manifests.filter(([, json]) => isObject(json));
  for (const [path, json] of present) {
    if (!SEMVER.test(json.version ?? "")) problems.push(`${path}: version must look like 1.2.3`);
  }
  for (const field of ["version", "description"]) {
    const values = new Set(present.map(([, json]) => json[field]));
    if (values.size > 1) problems.push(`${field} differs across ${present.map(([path, json]) => `${path} (${JSON.stringify(json[field])})`).join(", ")}; keep them the same`);
  }
}

/**
 * Checks the plugin package and the manifests that point at it.
 * `release` also fails while the demo video URL is still the placeholder.
 * Returns a list of problems; an empty list means the package is valid.
 */
export function checkPluginPackage(root, { release = false } = {}) {
  const problems = [];
  if (!existsSync(join(root, PLUGIN_DIR))) return [`${PLUGIN_DIR}: missing`];
  const agent = checkAgentManifest(root, release, problems);
  const claude = checkClaudeManifest(root, problems);
  const gemini = checkGeminiManifest(root, problems);
  const cursor = checkCursorMarketplace(root, problems);
  checkMcpFiles(root, problems);
  checkSkillCopies(root, problems);
  checkPluginFiles(root, problems);
  checkNoTokens(root, problems);
  checkReadmeAndLicense(root, problems);
  checkAgreement(
    [
      [`${PLUGIN_DIR}/plugin.json`, agent],
      [`${PLUGIN_DIR}/.claude-plugin/plugin.json`, claude],
      ["gemini-extension.json", gemini],
      [".cursor-plugin/marketplace.json plugins[0]", cursor],
    ],
    problems,
  );
  return problems;
}
