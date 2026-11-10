#!/usr/bin/env node
// Builds an import inventory from unzipped Claude and ChatGPT data exports and
// from folders of documents (plans, specs, reports). It reads the sources and
// never changes them, uses no network, and needs only Node 18 or later.
//
//   node inventory.mjs scan --out <dir> --source <path> [--account <label>] [--origin <name>] [--source ...]
//   node inventory.mjs redact --out <dir> --key <imp-...> [--rules <rule,rule>]
//
// `scan` writes <out>/inventory.json and one file per item under <out>/items/.
// Each --source starts a new source; the --account and --origin after it
// apply to that source. A Claude or ChatGPT export is detected from its
// conversation files; any other folder is read as documents, and --origin
// (claude-code, codex, cursor, claude, chatgpt, files) says where they came
// from. Running `scan` again into the same --out keeps earlier redactions.
// `redact` replaces secret findings in one extracted item, never the source.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// artifacts.space limits: content is 1 to 1,000,000 characters and at most 1 MiB; titles are 1 to 160 characters.
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_CONTENT_BYTES = 1_048_576;
const MAX_TITLE_CHARS = 160;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // artifacts.space file upload limit
const MAX_JSON_BYTES = 500 * 1024 * 1024; // above this, Node cannot hold the file as one string
const MAX_DOCS = 5000;
const MAX_FINDINGS = 200;

/** A secret rule. `group` names the capture group that holds the secret; 0 is the whole match. */
const rule = (name, source, flags = "", group = 0) => ({ name, pattern: new RegExp(source, `gd${flags}`), group });

// Every run is bounded so a long line (SVG paths, base64, minified code) scans in linear time.
const SECRET_RULES = [
  rule("private-key", String.raw`-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----`),
  rule("aws-access-key", String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
  rule("github-token", String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})`),
  rule("gitlab-token", String.raw`\bglpat-[A-Za-z0-9_-]{20,255}`),
  rule("npm-token", String.raw`\bnpm_[A-Za-z0-9]{36,255}`),
  rule("huggingface-token", String.raw`\bhf_[A-Za-z0-9]{30,255}`),
  rule("sendgrid-key", String.raw`\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128}`),
  rule("supabase-secret-key", String.raw`\bsb_secret_[A-Za-z0-9_-]{16,255}`),
  rule("anthropic-key", String.raw`\bsk-ant-[A-Za-z0-9_-]{20,255}`),
  rule("openai-key", String.raw`\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,255}`),
  rule("stripe-key", String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}`),
  rule("stripe-webhook-secret", String.raw`\bwhsec_[A-Za-z0-9+/=]{16,255}`),
  rule("slack-token", String.raw`\b(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,255}`),
  rule("slack-webhook", String.raw`https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9_/-]{20,255}`),
  rule("google-api-key", String.raw`\bAIza[0-9A-Za-z_-]{35}`),
  // Lookahead plus back-reference acts as an atomic group, so a long base64 run is never re-scanned.
  rule("jwt", String.raw`\beyJ(?=([A-Za-z0-9_-]{8,256}))\1\.eyJ(?=([A-Za-z0-9_-]{8,8192}))\2\.(?=([A-Za-z0-9_-]{8,1024}))\3`),
  rule("bearer-token", String.raw`\b[Bb][Ee][Aa][Rr][Ee][Rr][ \t]{1,4}([A-Za-z0-9._~+/=-]{20,2048})`, "", 1),
  // The password may hold "/", but a port followed by a path ("host:8080/a@b") is not a password.
  rule("connection-string", String.raw`\b[a-z][a-z0-9+.-]{0,20}:\/\/(?!\[REDACTED)([^\s:/@'"]{0,256}:(?!\d{1,5}\/)[^\s@'"?#]{1,256})@[^\s'"]{1,256}`, "i", 1),
  rule("env-secret", String.raw`^[ \t]{0,8}(?:export[ \t]{1,4})?[A-Z][A-Z0-9_]{0,64}(?:KEY|SECRET|TOKEN|PASS[A-Z0-9_]{0,16}|DSN|PWD)[ \t]{0,4}=[ \t]{0,4}["']?([^\s"'#$<\[][^\s"'#]{7,1023})`, "m", 1),
  rule("secret-assignment", String.raw`(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]{0,32}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?(?!process\.env|\$|<|\[REDACTED)([^\s"'` + "`" + String.raw`,;]{8,1024})`, "i", 1),
];
const RULE_NAMES = new Set(SECRET_RULES.map((entry) => entry.name));

const CREDENTIAL_FILES = /^(?:\.env(?:\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.kdbx|id_[a-z0-9]+|auth\.json|credentials(?:\..*)?|\.npmrc|\.netrc|\.pgpass)$/i;
// Files in a data export that hold conversations or account data. A folder of documents never imports them.
const EXPORT_FILES = /^(?:(?:conversations(?:-\d+)?|users?|projects|memories|export_manifest|shared_conversations|message_feedback|user_settings|library[-_]files|group_chats|conversation_asset_file_names)\.json|chat\.html|.*\.jsonl(?:\.zst)?)$/i;
const CONVERSATION_FILES = /^conversations(?:-\d+)?\.json$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "vendor", "target", "coverage", "__pycache__"]);
const TEXT_FORMATS = {
  ".md": { kind: "markdown" }, ".mdx": { kind: "markdown" }, ".markdown": { kind: "markdown" },
  ".txt": { kind: "text" },
  ".json": { kind: "json" }, ".csv": { kind: "csv" }, ".svg": { kind: "svg" },
  ".mmd": { kind: "mermaid" }, ".mermaid": { kind: "mermaid" },
};
const FILE_TYPES = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const LANGUAGE_EXTENSIONS = {
  python: ".py", javascript: ".js", typescript: ".ts", tsx: ".tsx", jsx: ".jsx", html: ".html", css: ".css", json: ".json",
  bash: ".sh", shell: ".sh", sh: ".sh", sql: ".sql", go: ".go", rust: ".rs", java: ".java", ruby: ".rb", yaml: ".yml",
  swift: ".swift", kotlin: ".kt", c: ".c", cpp: ".cpp", csharp: ".cs", php: ".php", markdown: ".md",
};
// Code files count only in a folder of artifacts downloaded from Claude or ChatGPT.
const DOWNLOAD_FORMATS = new Map([
  ...Object.entries(LANGUAGE_EXTENSIONS).filter(([language]) => language !== "markdown").map(([language, extension]) => [extension, { kind: "code", language }]),
  [".htm", { kind: "code", language: "html" }],
]);
// What a text item uploads as when it is too large for an artifact: artifacts.space files take .md, .txt, .csv, and .json, not code or markup.
const FILE_FALLBACK = { markdown: ".md", text: ".txt", csv: ".csv", json: ".json" };
const ORIGINS = new Set(["claude", "chatgpt", "claude-code", "codex", "cursor", "files"]);
const REPLAY_FAILED = "An edit could not be replayed; compare with the original";

/** Fails with a message for the person running the script. */
function fail(message) {
  console.error(`inventory: ${message}`);
  process.exit(1);
}

/** Parses `scan` and `redact` arguments. Each --source opens a new source group. */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, out: null, key: null, rules: null, sources: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    index += 1;
    const current = options.sources.at(-1);
    if (flag === "--out") options.out = resolve(value);
    else if (flag === "--key") options.key = value;
    else if (flag === "--rules") {
      options.rules = new Set(value.split(",").map((name) => name.trim()).filter(Boolean));
      if (options.rules.size === 0) fail("--rules needs at least one rule name");
    }
    else if (flag === "--source") options.sources.push({ path: resolve(value), account: "default", origin: null });
    else if (flag === "--account" && current) current.account = value;
    else if (flag === "--origin" && current) current.origin = value;
    else fail(`unexpected ${flag}; --account and --origin follow a --source`);
  }
  return options;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const toIso = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const megabytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

// ---------- Paths ----------

const caseInsensitivePaths = process.platform === "darwin" || process.platform === "win32";

/** A path's real location (symlinks resolved, also for paths that do not exist yet), compared case-insensitively where the file system is. */
function realish(path) {
  let current = resolve(path);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    // Keep the resolved path.
  }
  const full = join(real, ...rest);
  return caseInsensitivePaths ? full.toLowerCase() : full;
}

/** Whether `child` is `parent` or inside it as written, before symlinks are resolved. */
function isInsideAsWritten(child, parent) {
  const fold = (path) => (caseInsensitivePaths ? resolve(path).toLowerCase() : resolve(path));
  const inner = fold(child);
  const outer = fold(parent);
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** Whether `child` is `parent` or inside it. */
function isInside(child, parent) {
  const inner = realish(child);
  const outer = realish(parent);
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * Coding-agent home folders. Inside one, nothing is read by default: only a
 * plans/ folder that stays inside that home. Sessions, chats, settings, and
 * memory are never read.
 */
function agentHomes() {
  const home = homedir();
  const homes = [".claude", ".codex", ".cursor", ".gemini", join(".local", "share", "opencode"), join(".config", "opencode")].map((name) => join(home, name));
  for (const variable of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "OPENCODE_CONFIG_DIR"]) {
    if (process.env[variable]) homes.push(resolve(process.env[variable]));
  }
  return homes;
}

/** Finds files by name up to three folders deep, so nested exports still work. */
function findFiles(root, test, depth = 3) {
  const found = [];
  const walk = (folder, level) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isFile() && test(entry.name)) found.push(path);
      else if (entry.isDirectory() && level < depth && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) walk(path, level + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/** Reads a JSON file, or stops with a plain message when it is too large, cut short, or unreadable. */
function readJson(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return fail(`could not read ${path}. Download and unzip that export again.`);
  }
  const tooLarge = () => fail(`${path} is ${megabytes(size)}, too large for this helper (it reads files up to ${megabytes(MAX_JSON_BYTES)}). Import from a smaller export, or split it first.`);
  if (size > MAX_JSON_BYTES) return tooLarge();
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ERR_STRING_TOO_LONG" || error instanceof RangeError) return tooLarge();
    return fail(`could not read ${path} (${error instanceof SyntaxError ? "not complete JSON" : "unreadable"}). Download and unzip that export again.`);
  }
}

// ---------- Secrets ----------

/** The start index of every line, for line numbers without re-scanning the text. */
function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Secret ranges in the text, earlier rules winning where two overlap. */
function findSecrets(text, rules = null) {
  const found = [];
  let truncated = false;
  for (const { name, pattern, group } of SECRET_RULES) {
    if (rules && !rules.has(name)) continue;
    let count = 0;
    for (const match of text.matchAll(pattern)) {
      const [start, end] = match.indices[group];
      if (found.some((other) => start < other.end && other.start < end)) continue;
      // The cap is per rule, so one noisy rule never hides another rule's findings.
      if (count >= MAX_FINDINGS) {
        truncated = true;
        break;
      }
      count += 1;
      found.push({ rule: name, start, end, matchStart: match.index });
    }
  }
  return { found: found.sort((a, b) => a.start - b.start), truncated };
}

/** Each secret finding: its rule, line, and a masked preview that never shows the value. */
function scanSecrets(text) {
  const { found, truncated } = findSecrets(text);
  const starts = lineStarts(text);
  const findings = found.map(({ rule: name, start, end, matchStart }) => {
    const label = text.slice(matchStart, start).replace(/\s+/g, " ").trim().slice(-40);
    let preview = `${label || text.slice(start, start + 4)}… (${end - start} characters)`;
    if (name === "private-key") preview = "-----BEGIN … PRIVATE KEY-----";
    return { rule: name, line: lineAt(starts, start), preview };
  });
  return { findings, truncated };
}

/** Where a private key block ends: its END line, or the end of the armor and base64 lines after BEGIN. */
function privateKeyEnd(text, from) {
  const endMarker = text.indexOf("-----END ", from);
  if (endMarker !== -1 && endMarker - from < 20_000) {
    const close = text.indexOf("-----", endMarker + 9);
    if (close !== -1) return close + 5;
  }
  // Key lines may be indented (YAML) or quoted (Markdown "> "): the prefix is ignored when matching.
  const body = (line) => line.replace(/\r$/, "").replace(/^[ \t]{0,40}(?:>[ \t]?){0,8}[ \t]{0,40}/, "");
  const base64Line = (line) => /^[A-Za-z0-9+/=]{4,200}$/.test(body(line));
  // Armor headers ("Version: …") come only before the first base64 line.
  let headersAllowed = true;
  const keyLine = (line) => base64Line(line) || (headersAllowed && /^[A-Za-z-]{2,30}: .{0,200}$/.test(body(line)));
  const lines = text.slice(from, from + 20_000).split("\n");
  let end = from + lines[0].length;
  for (let index = 1; index < lines.length; index += 1) {
    const line = body(lines[index]);
    if (base64Line(line)) headersAllowed = false;
    // A blank line belongs to the key only when key lines follow it (PGP armor puts one after its headers).
    if (!keyLine(line) && !(line === "" && keyLine(lines[index + 1] ?? ""))) break;
    end += 1 + lines[index].length;
  }
  return end;
}

/** Replaces findings of the chosen rules with a marker, keeping names such as `API_KEY=`. */
function redactText(text, rules) {
  const { found } = findSecrets(text, rules);
  let result = text;
  for (const { rule: name, start, end } of [...found].reverse()) {
    const stop = name === "private-key" ? privateKeyEnd(result, end) : end;
    result = `${result.slice(0, start)}[REDACTED:${name}]${result.slice(stop)}`;
  }
  return result;
}

// ---------- Titles and formats ----------

function cleanTitle(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

/** A title artifacts.space accepts (1 to 160 characters), and the full title when it had to be cut. */
function fitTitle(raw, fallback) {
  const clean = cleanTitle(raw) || fallback;
  if (clean.length <= MAX_TITLE_CHARS) return { title: clean, fullTitle: null };
  let cut = clean.slice(0, MAX_TITLE_CHARS - 1).trimEnd();
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { title: `${cut}…`, fullTitle: clean };
}

const untitled = (what, date) => `Untitled ${what}${date ? ` (${date.slice(0, 10)})` : ""}`;

function documentTitle(text, path) {
  const frontmatter = /^---\r?\n([\s\S]{0,4096}?)\r?\n---/.exec(text);
  for (const line of frontmatter ? frontmatter[1].split(/\r?\n/) : []) {
    const named = /^(?:title|name):[ \t]*(.*)$/.exec(line);
    if (named && cleanTitle(named[1])) return named[1];
  }
  const heading = /^#[ \t]+(.*\S)/m.exec(text.slice(0, 100_000));
  return heading && cleanTitle(heading[1]) ? heading[1] : basename(path, extname(path));
}

/** Maps a Claude artifact MIME type to an artifacts.space format guess. */
function claudeFormat(type, language) {
  if (type === "text/markdown") return { kind: "markdown" };
  if (type === "image/svg+xml") return { kind: "svg" };
  if (type === "application/vnd.ant.mermaid") return { kind: "mermaid" };
  if (type === "text/html") return { kind: "code", language: "html", note: "HTML page: artifacts.space shows the source, not a live page" };
  if (type === "application/vnd.ant.react") return { kind: "code", language: language || "jsx", note: "React component: artifacts.space shows the source, not a live page" };
  if (type === "application/vnd.ant.code") return { kind: "code", language: language || "" };
  return { kind: "text" };
}

/** Maps a ChatGPT canvas type ("document", "code/python") to a format guess. */
function canvasFormat(type) {
  if (!type || type === "document") return { kind: "markdown" };
  if (typeof type === "string" && type.startsWith("code/")) {
    const language = type.slice(5);
    const live = language === "react" || language === "html";
    return { kind: "code", language: language === "react" ? "jsx" : language, note: live ? "Live canvas preview: artifacts.space shows the source" : undefined };
  }
  return { kind: "text" };
}

function extensionFor(format) {
  if (format.kind === "markdown") return ".md";
  if (format.kind === "code") return LANGUAGE_EXTENSIONS[format.language?.toLowerCase()] ?? ".txt";
  return { json: ".json", csv: ".csv", svg: ".svg", mermaid: ".mmd" }[format.kind] ?? ".txt";
}

function parsesAsJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- Claude exports ----------

/** Final versions of the Claude artifacts in one conversation, with edits replayed, and counts of what could not be used. */
function claudeArtifacts(conversation) {
  const artifacts = new Map();
  const problems = { unknownEdits: 0, emptyVersions: 0 };
  const messages = (Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [])
    .map((message, index) => ({ message, index, time: Date.parse(message?.created_at ?? "") }))
    .filter(({ message }) => message && typeof message === "object")
    // Oldest first by real time; export order breaks ties and covers messages without a date.
    .sort((a, b) => (Number.isNaN(a.time) || Number.isNaN(b.time) || a.time === b.time ? a.index - b.index : a.time - b.time))
    .map(({ message }) => message);
  const apply = (input, at) => {
    const id = input.id || `untitled-${artifacts.size}`;
    const existing = artifacts.get(id);
    if (input.command === "update") {
      if (!existing) {
        problems.unknownEdits += 1;
        return;
      }
      const oldText = typeof input.old_str === "string" ? input.old_str : "";
      if (oldText && existing.content.includes(oldText)) existing.content = existing.content.replace(oldText, () => (typeof input.new_str === "string" ? input.new_str : ""));
      else existing.notes.add(REPLAY_FAILED);
      return;
    }
    if (typeof input.content !== "string") {
      if (existing) existing.notes.add("A later version had no content; the version before it is kept");
      else problems.emptyVersions += 1;
      return;
    }
    const base = existing ?? { notes: new Set(), createdAt: at };
    artifacts.set(id, {
      ...base,
      title: input.title || existing?.title || "",
      type: input.type || existing?.type || "",
      language: input.language || existing?.language || "",
      content: input.content,
    });
  };
  for (const message of messages) {
    if (message.sender !== "assistant") continue;
    const at = message.created_at ?? null;
    const blocks = Array.isArray(message.content) ? message.content.filter((block) => block && typeof block === "object") : [];
    for (const block of blocks) {
      if (block.type === "tool_use" && block.name === "artifacts" && block.input && typeof block.input === "object") apply(block.input, at);
    }
    // Older exports kept artifacts inline in the message text.
    const textBlocks = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text);
    const text = textBlocks.length > 0 ? textBlocks.join("\n") : typeof message.text === "string" ? message.text : "";
    for (const match of text.matchAll(/<antArtifact\b([^>]{0,2000})>([\s\S]*?)<\/antArtifact>/g)) {
      const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]));
      apply({ command: "create", id: attrs.identifier, type: attrs.type, title: attrs.title, language: attrs.language, content: match[2].replace(/^\n/, "") }, at);
    }
  }
  return { artifacts: [...artifacts.values()], problems };
}

function readClaudeExport(folder, source, conversations) {
  const skipped = [];
  const skip = (path, reason) => skipped.push({ path, reason });
  const projectsFile = join(folder, "projects.json");
  let projectList = existsSync(projectsFile) ? readJson(projectsFile) : [];
  if (!Array.isArray(projectList)) {
    skip("projects.json", "Not a list of projects; project names are not suggested");
    projectList = [];
  }
  const projects = new Map(projectList.filter((project) => project && typeof project === "object").map((project) => [project.uuid, project.name]));
  // Owners are numbered, never named: an organization export can hold several people's chats.
  const owners = new Map();
  const items = [];
  let empty = 0;
  for (const conversation of conversations) {
    if (!conversation || typeof conversation !== "object") {
      empty += 1;
      continue;
    }
    const label = `Claude conversation ${conversation.uuid ?? "without an id"}`;
    try {
      const ownerId = conversation.account?.uuid;
      if (ownerId && !owners.has(ownerId)) owners.set(ownerId, `owner-${owners.size + 1}`);
      const { artifacts, problems } = claudeArtifacts(conversation);
      if (problems.unknownEdits > 0) skip(label, `${problems.unknownEdits} artifact edit(s) refer to an artifact that is not in the export`);
      if (problems.emptyVersions > 0) skip(label, `${problems.emptyVersions} artifact(s) had no content`);
      for (const artifact of artifacts) {
        const format = claudeFormat(artifact.type, artifact.language);
        const createdAt = toIso(artifact.createdAt) ?? toIso(conversation.created_at);
        items.push({
          type: "claude-artifact",
          // An untitled artifact never takes the conversation's name.
          ...fitTitle(artifact.title, untitled("artifact", createdAt)),
          content: artifact.content,
          format,
          createdAt,
          originalUrl: conversation.uuid ? `https://claude.ai/chat/${conversation.uuid}` : null,
          conversationTitle: typeof conversation.name === "string" ? conversation.name : "",
          suggestedProject: projects.get(conversation.project_uuid) ?? null,
          notes: [...artifact.notes, format.note].filter(Boolean),
          exportOwner: owners.get(ownerId) ?? null,
          source,
        });
      }
    } catch {
      skip(label, "Could not be read; its artifacts were not read");
    }
  }
  if (empty > 0) skip("conversations.json", `${empty} empty conversation entries`);
  return { items, owners: owners.size, skipped };
}

// ---------- ChatGPT exports ----------

/** The messages on the branch the user last saw, oldest first. */
function activeBranch(conversation) {
  const mapping = conversation.mapping && typeof conversation.mapping === "object" ? conversation.mapping : {};
  let nodeId = conversation.current_node && mapping[conversation.current_node] ? conversation.current_node : null;
  if (!nodeId) {
    let latest = -Infinity;
    for (const [id, node] of Object.entries(mapping)) {
      const time = Number(node?.message?.create_time ?? -Infinity);
      if (time > latest) [latest, nodeId] = [time, id];
    }
  }
  const branch = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    if (mapping[nodeId].message && typeof mapping[nodeId].message === "object") branch.push(mapping[nodeId].message);
    nodeId = mapping[nodeId].parent;
  }
  return branch.reverse();
}

function messageText(message) {
  const content = message?.content ?? {};
  if (typeof content.text === "string") return content.text;
  return (Array.isArray(content.parts) ? content.parts : []).map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
}

/** A Python `re` pattern as a JS RegExp, or null when it uses something JS cannot match the same way. */
function pythonRegex(pattern, global, asciiOnly = true) {
  let body = pattern;
  let flags = global ? "g" : "";
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(body);
  if (inline) {
    for (const flag of inline[1]) {
      if (flag !== "i" && flag !== "m" && flag !== "s") return null;
      if (!flags.includes(flag)) flags += flag;
    }
    body = body.slice(inline[0].length);
  }
  if (/\(\?[aiLmsux]+[):]/.test(body) || /\(\?[>#]/.test(body)) return null;
  const escapes = [...body.matchAll(/\\(.)/gs)].map((match) => match[1]);
  // Under (?m) Python's \A and \Z still mean the whole string; JS ^ and $ would mean each line.
  if (flags.includes("m") && (escapes.includes("A") || escapes.includes("Z"))) return null;
  // JS \w and \b are ASCII-only where Python's are Unicode, so they only match the same way on ASCII text.
  if (!asciiOnly && escapes.some((char) => "wWbB".includes(char))) return null;
  // Escapes are read in pairs, so an escaped backslash before "A" stays a backslash.
  body = body
    .replace(/\\(.)/gs, (escape, char) => (char === "A" ? "^" : char === "Z" ? "$" : escape))
    .replace(/\(\?P<(\w+)>/g, "(?<$1>")
    .replace(/\(\?P=(\w+)\)/g, "\\k<$1>");
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/** Renders a Python replacement template (`\1`, `\g<1>`, `\g<name>`, `\n`) for one match. */
function pythonTemplate(template) {
  const parts = [];
  let literal = "";
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    if (char !== "\\" || index === template.length - 1) {
      literal += char;
      continue;
    }
    const ahead = template.slice(index + 1, index + 80);
    const named = /^g<(\w+)>/.exec(ahead);
    const digits = /^\d{1,2}/.exec(ahead);
    if (named || digits) {
      const reference = named ? named[1] : digits[0];
      parts.push(literal, { group: /^\d+$/.test(reference) ? Number(reference) : reference });
      literal = "";
      index += (named ?? digits)[0].length;
      continue;
    }
    const escapes = { n: "\n", t: "\t", r: "\r", "\\": "\\" };
    literal += escapes[ahead[0]] ?? `\\${ahead[0]}`;
    index += 1;
  }
  parts.push(literal);
  return (match) => parts.map((part) => (typeof part === "string" ? part : (typeof part.group === "number" ? match[part.group] : match.groups?.[part.group]) ?? "")).join("");
}

/** Applies one canvas edit. Returns false when it cannot be replayed. */
function applyCanvasUpdate(doc, update) {
  if (!update || typeof update !== "object" || typeof update.pattern !== "string") return false;
  const { pattern } = update;
  const replacement = typeof update.replacement === "string" ? update.replacement : "";
  if (pattern === ".*" || pattern === "^.*$" || pattern === "(?s).*") {
    doc.content = replacement;
    return true;
  }
  const regex = pythonRegex(pattern, Boolean(update.multiple), !/[^\x00-\x7f]/.test(doc.content));
  if (!regex) return false;
  const render = pythonTemplate(replacement);
  let output = "";
  let last = 0;
  let replaced = false;
  for (let match = regex.exec(doc.content); match; match = regex.global ? regex.exec(doc.content) : null) {
    output += doc.content.slice(last, match.index) + render(match);
    last = match.index + match[0].length;
    replaced = true;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (!replaced) return false;
  doc.content = output + doc.content.slice(last);
  return true;
}

/** Final versions of the canvas documents on a conversation's active branch, with counts of what could not be used. */
function canvasDocuments(conversation) {
  const docs = [];
  let unreadable = 0;
  let unmatched = 0;
  let current = null;
  for (const message of activeBranch(conversation)) {
    const role = message.author?.role;
    const textdocId = message.metadata?.canvas?.textdoc_id;
    if (role === "tool" && textdocId && current && !current.id) current.id = textdocId;
    if (role !== "assistant") continue;
    const recipient = message.recipient ?? "";
    if (recipient !== "canmore.create_textdoc" && recipient !== "canmore.update_textdoc") continue;
    let input = null;
    try {
      input = JSON.parse(messageText(message));
    } catch {
      input = null;
    }
    if (recipient === "canmore.create_textdoc") {
      if (!input || typeof input !== "object" || typeof input.content !== "string") {
        // A stand-in keeps this canvas's id and edits, so they never land on another canvas.
        unreadable += 1;
        current = { id: null, unreadable: true };
        docs.push(current);
        continue;
      }
      current = { id: null, name: input.name ?? "", type: input.type ?? "document", content: input.content, createdAt: message.create_time, notes: new Set() };
      docs.push(current);
      continue;
    }
    // An edit naming a canvas goes only to that canvas; one naming none goes to the latest.
    const named = input && typeof input === "object" && input.textdoc_id;
    const target = named ? docs.find((doc) => doc.id === input.textdoc_id) : current;
    if (!target) {
      unmatched += 1;
      continue;
    }
    if (target.unreadable) continue;
    const updates = input && typeof input === "object" && Array.isArray(input.updates) ? input.updates : null;
    if (!updates) {
      target.notes.add(REPLAY_FAILED);
      continue;
    }
    for (const update of updates) {
      if (!applyCanvasUpdate(target, update)) target.notes.add(REPLAY_FAILED);
    }
  }
  const readable = docs.filter((doc) => !doc.unreadable);
  // An edit that matched no canvas may belong to one whose id the export never gave.
  if (unmatched > 0) for (const doc of readable) if (!doc.id) doc.notes.add("An edit may belong to this canvas and could not be replayed; compare with the original");
  return { docs: readable, unreadable, unmatched };
}

/** How many canvas documents a conversation creates on branches other than the active one. */
function offBranchCanvasCount(conversation) {
  const onBranch = new Set(activeBranch(conversation));
  const nodes = Object.values(conversation.mapping && typeof conversation.mapping === "object" ? conversation.mapping : {});
  return nodes.filter((node) => node?.message && !onBranch.has(node.message) && node.message.author?.role === "assistant" && node.message.recipient === "canmore.create_textdoc").length;
}

function readChatGptExport(folder, source, shards, firstShard) {
  const items = [];
  const skipped = [];
  for (const shard of shards) {
    const data = shard === shards[0] ? firstShard : readJson(shard);
    const conversations = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : [data];
    for (const conversation of conversations) {
      if (!conversation || typeof conversation !== "object" || !conversation.mapping) continue;
      const id = conversation.conversation_id ?? conversation.id;
      const label = `ChatGPT conversation ${id ?? "without an id"}`;
      try {
        const { docs, unreadable, unmatched } = canvasDocuments(conversation);
        const offBranch = offBranchCanvasCount(conversation);
        if (unreadable > 0) skipped.push({ path: label, reason: `${unreadable} canvas document(s) could not be read from the export` });
        if (unmatched > 0) skipped.push({ path: label, reason: `${unmatched} canvas edit(s) matched no canvas and were not applied` });
        if (offBranch > 0) skipped.push({ path: label, reason: `${offBranch} canvas document(s) on an earlier branch of the conversation were not read; only the branch the user last viewed is` });
        for (const doc of docs) {
          const format = canvasFormat(doc.type);
          const createdAt = toIso(doc.createdAt) ?? toIso(conversation.create_time);
          items.push({
            type: "chatgpt-canvas",
            ...fitTitle(doc.name, untitled("canvas", createdAt)),
            content: doc.content,
            format,
            createdAt,
            originalUrl: id ? `https://chatgpt.com/c/${id}` : null,
            conversationTitle: typeof conversation.title === "string" ? conversation.title : "",
            suggestedProject: null,
            notes: [...doc.notes, format.note].filter(Boolean),
            source,
          });
        }
      } catch {
        skipped.push({ path: label, reason: "Could not be read; its canvases were not read" });
      }
    }
  }
  items.push(...chatGptReports(folder, source, skipped));
  return { items, owners: 1, skipped };
}

/** Generated reports listed in library_files.json, when the file is in the export. */
function chatGptReports(folder, source, skipped) {
  const library = readdirSafe(folder).find((name) => /^library[-_]files\.json$/i.test(name));
  if (!library) return [];
  const libraryPath = join(folder, library);
  const skip = (path, reason) => skipped.push({ path: relative(folder, path) || ".", reason });
  const files = readdirSafe(folder);
  const entries = readJson(libraryPath);
  if (!Array.isArray(entries)) {
    skip(libraryPath, "Not a list of library files; its reports were not read");
    return [];
  }
  const reports = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.library_artifact_type !== "report" || entry.trashed_at || entry.deleted_at || typeof entry.file_id !== "string" || !entry.file_id) continue;
    const id = entry.file_id;
    const stored = files.find((name) => name === id || name.startsWith(`${id}-`) || name.startsWith(`${id}.`));
    if (!stored) continue;
    const path = join(folder, stored);
    const title = fitTitle(entry.file_name, "Untitled report");
    if (EXPORT_FILES.test(stored) || CREDENTIAL_FILES.test(stored)) {
      skip(path, `Report "${title.title}" points at export or credential data; never imported`);
      continue;
    }
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      skip(path, `Report "${title.title}" could not be read`);
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      skip(path, `Report "${title.title}" is not a regular file`);
      continue;
    }
    if (stats.size > MAX_FILE_BYTES) {
      skip(path, `Report "${title.title}" is larger than the 25 MB file limit`);
      continue;
    }
    const base = {
      type: "chatgpt-report",
      ...title,
      createdAt: toIso(entry.created_at),
      originalUrl: entry.origination_thread_id ? `https://chatgpt.com/c/${entry.origination_thread_id}` : null,
      conversationTitle: "",
      suggestedProject: null,
      notes: ["Found in the ChatGPT library; this export layout is not documented by OpenAI"],
      source,
    };
    const mime = typeof entry.mime_type === "string" ? entry.mime_type : "";
    if (!/^text\/|markdown|json/.test(mime)) {
      reports.push({ ...base, filePath: path, contentType: mime || "application/octet-stream", format: { kind: "file" } });
      continue;
    }
    try {
      reports.push({ ...base, content: readFileSync(path, "utf8"), format: { kind: "markdown" } });
    } catch {
      skip(path, `Report "${title.title}" could not be read`);
    }
  }
  return reports;
}

function readdirSafe(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

// ---------- Document folders ----------

/**
 * The repository folder name above a file, for a project suggestion. It looks
 * only inside the source folder (the source itself included), so a .git in a
 * parent folder such as the home folder never names a project.
 */
function repositoryName(path, root) {
  let folder = dirname(path);
  while (isInsideAsWritten(folder, root)) {
    if (existsSync(join(folder, ".git"))) return basename(folder);
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return null;
}

function readDocuments(root, source) {
  // A folder of artifacts downloaded from Claude or ChatGPT also takes code files; a repository folder does not.
  const downloads = source.origin === "claude" || source.origin === "chatgpt";
  const homes = agentHomes();
  const items = [];
  const skipped = [];
  const skip = (path, reason) => skipped.push({ path: relative(root, path) || ".", reason });
  const walk = (folder) => {
    // A folder named inside an agent home that resolves somewhere else (a symlinked plans/) is not followed.
    const namedHome = homes.find((candidate) => isInsideAsWritten(folder, candidate));
    if (namedHome && !isInside(folder, namedHome)) {
      skip(folder, "Points outside its coding-agent folder; not read");
      return;
    }
    const home = homes.find((candidate) => isInside(folder, candidate));
    if (home && !isInside(folder, join(home, "plans"))) {
      // Inside a coding agent's home only plans/ is read: never sessions, transcripts, settings, or memory.
      if (realish(folder) !== realish(home)) {
        skip(folder, "Coding-agent session data or settings; only its plans folder is read");
        return;
      }
      const others = readdirSafe(folder).filter((name) => name !== "plans");
      if (others.length > 0) skip(folder, `${others.length} other files and folders in this coding-agent folder (sessions, settings, history) were not read; only plans/ is`);
      const plans = join(folder, "plans");
      if (existsSync(plans)) {
        if (isInside(plans, home)) walk(plans);
        else skip(plans, "plans/ points outside the coding-agent folder; not read");
      }
      return;
    }
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      skip(folder, "Could not be read");
      return;
    }
    if (entries.some((entry) => entry.name === "inventory.json" && entry.isFile()) && entries.some((entry) => entry.name === "items" && entry.isDirectory())) {
      skip(folder, "An earlier import inventory; never read as documents");
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) skip(path, "Build or dependency folder; not read");
        else if (!entry.name.startsWith(".")) walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (CREDENTIAL_FILES.test(entry.name)) {
        skip(path, "Looks like a credential file; never imported");
        continue;
      }
      if (EXPORT_FILES.test(entry.name)) {
        skip(path, "Looks like conversation or account data from an export; conversations are never imported");
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      const textFormat = TEXT_FORMATS[extension] ?? (downloads ? DOWNLOAD_FORMATS.get(extension) : undefined);
      const fileType = FILE_TYPES[extension];
      if (!textFormat && !fileType) continue;
      if (items.length >= MAX_DOCS) fail(`more than ${MAX_DOCS} documents under ${root}; pick a smaller folder`);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        skip(path, "Could not be read");
        continue;
      }
      if (stats.size > MAX_FILE_BYTES) {
        skip(path, "Larger than the 25 MB file limit");
        continue;
      }
      const base = {
        type: "document",
        createdAt: stats.mtime.toISOString(),
        originalUrl: null,
        originalPath: path,
        conversationTitle: "",
        suggestedProject: repositoryName(path, root),
        notes: [],
        source,
      };
      if (!textFormat) {
        items.push({ ...base, ...fitTitle(basename(path), "Untitled file"), filePath: path, contentType: fileType, format: { kind: "file" }, notes: ["Binary file: not scanned for secrets; ask the user to check it"] });
        continue;
      }
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        skip(path, "Could not be read");
        continue;
      }
      const format = textFormat.kind === "json" && !parsesAsJson(text) ? { kind: "text" } : { ...textFormat };
      items.push({ ...base, ...fitTitle(documentTitle(text, path), "Untitled document"), content: text, format });
    }
  };
  walk(root);
  return { items, owners: 1, skipped };
}

// ---------- Sources ----------

/** Folders under a source that hold conversation files, each with its files in order. */
function exportFolders(root) {
  const folders = new Map();
  for (const path of findFiles(root, (name) => CONVERSATION_FILES.test(name))) {
    const folder = dirname(path);
    folders.set(folder, [...(folders.get(folder) ?? []), path].sort());
  }
  return folders;
}

/** Other entries in the folders between a source and the export inside it, which the export reader does not look at. */
function entriesBesideExport(root, folder) {
  const others = [];
  let current = folder;
  while (current !== root && isInside(current, root)) {
    const parent = dirname(current);
    for (const name of readdirSafe(parent)) if (name !== basename(current) && !name.startsWith(".")) others.push(join(parent, name));
    current = parent;
  }
  return others;
}

/** Whether a folder holding conversation files also holds the other files of a Claude or ChatGPT export. */
function looksLikeExport(folder) {
  const names = new Set(readdirSafe(folder));
  return ["users.json", "projects.json", "memories.json", "chat.html", "user.json", "export_manifest.json"].some((name) => names.has(name));
}

/**
 * Reads one source with the reader its files call for. A source is an export
 * only when its export files sit at its root (or under wrapper folders with
 * nothing beside them). A conversations.json elsewhere in a document folder is
 * listed as skipped, never parsed. Several exports in one source are refused.
 */
function readSource(source) {
  if (!existsSync(source.path) || !statSync(source.path).isDirectory()) fail(`${source.path} is not a folder. Unzip an export into its own empty folder first.`);
  const exports = [...exportFolders(source.path)].filter(([folder]) => looksLikeExport(folder));
  if (exports.length > 1) {
    const names = exports.map(([folder]) => relative(source.path, folder) || ".").join(", ");
    fail(`${source.path} holds ${exports.length} exports (${names}). Give each one its own --source with its own --account.`);
  }
  const documents = () => ({ ...readDocuments(source.path, { ...source, origin: source.origin ?? "files" }), kind: "documents" });
  if (exports.length === 0 || entriesBesideExport(source.path, exports[0][0]).length > 0) return documents();

  const [[folder, files]] = exports;
  const first = readJson(files[0]);
  const list = Array.isArray(first) ? first : Array.isArray(first?.conversations) ? first.conversations : [first];
  const sample = list.find((entry) => entry && typeof entry === "object");
  const siblings = new Set(readdirSafe(folder));
  let kind = null;
  if (sample && "chat_messages" in sample) kind = "claude";
  else if (sample && "mapping" in sample) kind = "chatgpt";
  else if (!sample && (siblings.has("users.json") || siblings.has("projects.json"))) kind = "claude";
  else if (!sample && (siblings.has("chat.html") || siblings.has("user.json") || siblings.has("export_manifest.json"))) kind = "chatgpt";
  if (!kind) return documents();
  if (kind === "claude") {
    const extra = files.slice(1).map((path) => ({ path: relative(source.path, path), reason: "A Claude export has one conversations.json; extra files were not read" }));
    const result = readClaudeExport(folder, { ...source, origin: source.origin ?? "claude" }, list);
    return { ...result, skipped: [...extra, ...result.skipped], kind: "claude-export" };
  }
  return { ...readChatGptExport(folder, { ...source, origin: source.origin ?? "chatgpt" }, files, first), kind: "chatgpt-export" };
}

// ---------- Scan ----------

/** An earlier inventory in --out, so a re-run keeps its redactions. Refuses a folder that holds anything else. */
function previousInventory(out) {
  if (!existsSync(out)) return null;
  const entries = readdirSafe(out).filter((name) => !name.startsWith("."));
  if (entries.length === 0) return null;
  if (!entries.includes("inventory.json")) fail(`--out ${out} is not empty and holds no inventory.json; use an empty folder or an earlier inventory folder`);
  const inventory = readJson(join(out, "inventory.json"));
  if (!Array.isArray(inventory?.items)) fail(`${join(out, "inventory.json")} is not an inventory; use an empty folder`);
  return inventory;
}

/**
 * An item's file path from an inventory, only when it is `items/<key>.<ext>`
 * and really inside <out>/items (no "..", no symlink out). Otherwise null.
 */
function trustedItemPath(out, path, key) {
  if (typeof path !== "string" || typeof key !== "string") return null;
  const match = /^items\/(imp-[0-9a-f]{12})\.[a-z0-9]{1,10}$/.exec(path);
  if (!match || match[1] !== key) return null;
  const full = join(out, path);
  try {
    if (!lstatSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return isInside(full, join(out, "items")) ? path : null;
}

function sizeNote(format) {
  const fallback = FILE_FALLBACK[format.kind];
  if (fallback) return `Over the ${MAX_CONTENT_CHARS.toLocaleString("en-US")}-character limit for an artifact: upload it as a ${fallback} file, or split it`;
  return `Over the ${MAX_CONTENT_CHARS.toLocaleString("en-US")}-character limit for an artifact: upload it as a .txt file (artifacts.space files take no code, HTML, SVG, or Mermaid files), or skip it`;
}

function scan(options) {
  if (!options.out) fail("--out is required");
  if (options.sources.length === 0) fail("give at least one --source");
  for (const source of options.sources) {
    if (source.origin && !ORIGINS.has(source.origin)) fail(`--origin must be one of ${[...ORIGINS].join(", ")}`);
    if (isInside(options.out, source.path)) fail("--out must be outside every source folder");
    if (isInside(source.path, options.out)) fail("a --source must not be inside --out");
  }
  const previous = previousInventory(options.out);
  const redactedBefore = new Map((previous?.items ?? []).filter((item) => item?.redacted && typeof item.key === "string").map((item) => [item.key, item]));
  mkdirSync(join(options.out, "items"), { recursive: true });

  const byHash = new Map();
  const report = { sources: [], skipped: [], duplicatesMerged: 0 };
  for (const source of options.sources) {
    const result = readSource(source);
    report.sources.push({ path: source.path, account: source.account, kind: result.kind, items: result.items.length, owners: result.owners });
    report.skipped.push(...(result.skipped ?? []).map((entry) => ({ ...entry, account: source.account })));
    for (const item of result.items) {
      const bytes = item.filePath ? readFileSync(item.filePath) : Buffer.from(item.content, "utf8");
      const label = item.originalPath ? relative(source.path, item.originalPath) : item.title;
      if (bytes.length === 0) {
        report.skipped.push({ path: label, reason: "Empty; an artifact needs some content", account: source.account });
        continue;
      }
      if (!item.filePath && bytes.length > MAX_FILE_BYTES) {
        report.skipped.push({ path: label, reason: "Larger than the 25 MB file limit", account: source.account });
        continue;
      }
      const hash = sha256(bytes);
      const provenance = {
        origin: item.source.origin,
        account: item.source.account,
        createdAt: item.createdAt,
        originalUrl: item.originalUrl,
        originalPath: item.originalPath ?? null,
        conversationTitle: item.conversationTitle,
      };
      const known = byHash.get(hash);
      if (known) {
        report.duplicatesMerged += 1;
        known.provenance.push(provenance);
        if (!known.accounts.includes(item.source.account)) known.accounts.push(item.source.account);
        if (item.createdAt && (!known.createdAt || item.createdAt < known.createdAt)) known.createdAt = item.createdAt;
        continue;
      }
      const key = `imp-${hash.slice(0, 12)}`;
      const notes = [...item.notes];
      let path = `items/${key}${item.filePath ? extname(item.filePath).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin" : extensionFor(item.format)}`;
      let text = item.content;
      let redacted = false;
      const earlier = redactedBefore.get(key);
      const earlierPath = earlier ? trustedItemPath(options.out, earlier.path, key) : null;
      if (earlier && !earlierPath) notes.push("The earlier inventory's file for this item was not trusted, so it was extracted again; redact it again if needed");
      if (earlierPath) {
        // A re-run keeps the redacted copy instead of extracting the source again.
        path = earlierPath;
        text = readFileSync(join(options.out, path), "utf8");
        redacted = true;
      } else if (item.filePath) copyFileSync(item.filePath, join(options.out, path));
      else writeFileSync(join(options.out, path), item.content);
      const tooLarge = !item.filePath && (text.length > MAX_CONTENT_CHARS || Buffer.byteLength(text, "utf8") > MAX_CONTENT_BYTES);
      if (tooLarge) notes.push(sizeNote(item.format));
      const secrets = item.filePath ? { findings: [], truncated: false } : scanSecrets(text);
      if (secrets.truncated) notes.push(`More than ${MAX_FINDINGS} possible secrets of one kind; only the first ${MAX_FINDINGS} of each kind are listed, and more remain`);
      byHash.set(hash, {
        key,
        // The hash of the source item. A later redaction changes the file, not this hash or the key.
        sourceSha256: hash,
        title: item.title,
        ...(item.fullTitle ? { fullTitle: item.fullTitle } : {}),
        type: item.type,
        origin: item.source.origin,
        accounts: [item.source.account],
        createdAt: item.createdAt,
        sizeBytes: item.filePath ? bytes.length : Buffer.byteLength(text, "utf8"),
        characters: item.filePath ? null : text.length,
        format: { kind: item.format.kind, ...(item.format.language ? { language: item.format.language } : {}) },
        contentType: item.contentType ?? null,
        path,
        ...(tooLarge ? { uploadAs: FILE_FALLBACK[item.format.kind] ?? ".txt" } : {}),
        suggestedProject: item.suggestedProject,
        exportOwner: result.owners > 1 ? item.exportOwner ?? null : null,
        secrets: secrets.findings,
        binary: Boolean(item.filePath),
        ...(redacted ? { redacted: true } : {}),
        notes,
        provenance: [provenance],
      });
    }
  }

  const items = [...byHash.values()].sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const inventory = { version: 1, generatedAt: new Date().toISOString(), ...report, items };
  writeFileSync(join(options.out, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  printTable(inventory, options.out);
}

function printTable(inventory, out) {
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 60);
  console.log("| # | Key | Title | From | Accounts | Date | Size | Format | Secrets | Notes |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  inventory.items.forEach((item, index) => {
    const format = item.format.language ? `${item.format.kind} (${item.format.language})` : item.format.kind;
    console.log(`| ${index + 1} | ${item.key} | ${cell(item.title)} | ${item.origin} | ${cell(item.accounts.join(", "))} | ${(item.createdAt ?? "").slice(0, 10)} | ${item.sizeBytes} | ${format} | ${item.secrets.length} | ${item.notes.length} |`);
  });
  const withSecrets = inventory.items.filter((item) => item.secrets.length > 0).length;
  const multiOwner = inventory.sources.filter((source) => source.owners > 1).length;
  console.log(`\n${inventory.items.length} items, ${inventory.duplicatesMerged} duplicates merged, ${withSecrets} with possible secrets, ${inventory.skipped.length} skipped (listed in inventory.json).`);
  if (inventory.skipped.some((entry) => entry.reason.startsWith("Looks like conversation"))) {
    console.log("Some skipped files look like a data export the script did not recognise: check that each export is unzipped into its own folder.");
  }
  if (multiOwner > 0) console.log(`${multiOwner} export(s) hold more than one person's conversations: confirm which items the user may import.`);
  console.log(`Inventory: ${join(out, "inventory.json")}`);
}

function redact(options) {
  if (!options.out || !options.key) fail("redact needs --out and --key");
  const unknown = [...(options.rules ?? [])].filter((name) => !RULE_NAMES.has(name));
  if (unknown.length > 0) fail(`unknown rule(s) ${unknown.join(", ")}; the rules are ${[...RULE_NAMES].join(", ")}`);
  const inventoryPath = join(options.out, "inventory.json");
  const inventory = readJson(inventoryPath);
  const item = (inventory.items ?? []).find((entry) => entry.key === options.key);
  if (!item) fail(`no item ${options.key} in ${inventoryPath}`);
  if (item.binary) fail(`${options.key} is a binary file; skip it instead`);
  const trusted = trustedItemPath(options.out, item.path, item.key);
  if (!trusted) fail(`${options.key} has a file path outside ${join(options.out, "items")}; run scan again into an empty folder`);
  const path = join(options.out, trusted);
  const redacted = redactText(readFileSync(path, "utf8"), options.rules);
  writeFileSync(path, redacted);
  item.secrets = scanSecrets(redacted).findings;
  item.sizeBytes = Buffer.byteLength(redacted, "utf8");
  item.characters = redacted.length;
  item.redacted = true;
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`${options.key}: redacted; ${item.secrets.length} finding(s) left.`);
}

// For tests: the pure helpers, without running the command line.
export { applyCanvasUpdate, documentTitle, fitTitle, redactText, scanSecrets, SECRET_RULES };

const invokedDirectly = Boolean(process.argv[1]) && realish(process.argv[1]) === realish(fileURLToPath(import.meta.url));
const options = invokedDirectly ? parseArgs(process.argv.slice(2)) : null;
if (!options) {
  // Imported as a module: nothing to run.
} else if (options.command === "scan") scan(options);
else if (options.command === "redact") redact(options);
else fail("usage: inventory.mjs scan --out <dir> --source <path> [--account <label>] [--origin <name>] ... | redact --out <dir> --key <imp-...> [--rules <rule,rule>]");
