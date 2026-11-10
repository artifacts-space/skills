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
// apply to that source. A Claude or ChatGPT export is detected from its files;
// any other folder is read as documents, and --origin (claude-code, codex,
// cursor, claude, chatgpt, files) says where they came from.
// `redact` replaces secret findings in one extracted item, never the source.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const MAX_TEXT_BYTES = 1_048_576; // artifacts.space content limit per artifact
const MAX_FILE_BYTES = 25 * 1024 * 1024; // artifacts.space file upload limit
const MAX_DOCS = 5000;

const SECRET_RULES = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["connection-string", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"]+@[^\s'"]+/gi],
  ["secret-assignment", /\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?(?!process\.env|\$|<|\[REDACTED)[^\s"'`,;]{8,}/gi],
];

const CREDENTIAL_FILES = /^(?:\.env(?:\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.kdbx|id_[a-z0-9]+|auth\.json|credentials(?:\..*)?|\.npmrc|\.netrc|\.pgpass)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "vendor", "target", "coverage", "__pycache__"]);
const TEXT_FORMATS = {
  ".md": { kind: "markdown" }, ".mdx": { kind: "markdown" }, ".markdown": { kind: "markdown" },
  ".txt": { kind: "text" },
  ".json": { kind: "json" }, ".csv": { kind: "csv" }, ".svg": { kind: "svg" },
  ".mmd": { kind: "mermaid" }, ".mermaid": { kind: "mermaid" },
};
// Files in a data export that hold conversations or account data. A folder of documents never imports them.
const EXPORT_FILES = /^(?:(?:conversations(?:-\d+)?|users?|projects|memories|export_manifest|shared_conversations|message_feedback|user_settings|library[-_]files|group_chats|conversation_asset_file_names)\.json|chat\.html|.*\.jsonl(?:\.zst)?)$/i;
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
const ORIGINS = new Set(["claude", "chatgpt", "claude-code", "codex", "cursor", "files"]);

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
    else if (flag === "--rules") options.rules = new Set(value.split(","));
    else if (flag === "--source") options.sources.push({ path: resolve(value), account: "default", origin: null });
    else if (flag === "--account" && current) current.account = value;
    else if (flag === "--origin" && current) current.origin = value;
    else fail(`unexpected ${flag}; --account and --origin follow a --source`);
  }
  return options;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const toIso = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

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
      else if (entry.isDirectory() && level < depth && !entry.name.startsWith(".")) walk(path, level + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Each secret finding: its rule, line, and a masked preview that never shows the value. */
function scanSecrets(text) {
  const findings = [];
  for (const [rule, pattern] of SECRET_RULES) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      const value = match[0];
      const preview = rule === "private-key" ? "-----BEGIN … PRIVATE KEY-----" : `${value.slice(0, 4)}… (${value.length} characters)`;
      findings.push({ rule, line, preview });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** Replaces findings of the chosen rules with a marker. */
function redactText(text, rules) {
  let result = text;
  for (const [rule, pattern] of SECRET_RULES) {
    if (!rules || rules.has(rule)) result = result.replace(pattern, `[REDACTED:${rule}]`);
  }
  return result;
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
  if (type.startsWith("code/")) {
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

/** Final versions of the Claude artifacts in one conversation, with edits replayed. */
function claudeArtifacts(conversation) {
  const artifacts = new Map();
  const messages = [...(conversation.chat_messages ?? [])].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const apply = (input, at) => {
    const id = input.id || `untitled-${artifacts.size}`;
    const existing = artifacts.get(id);
    if (input.command === "update") {
      if (!existing) return;
      const oldText = input.old_str ?? "";
      if (oldText && existing.content.includes(oldText)) existing.content = existing.content.replace(oldText, () => input.new_str ?? "");
      else existing.notes.add("An edit could not be replayed; compare with the original");
      existing.updatedAt = at;
      return;
    }
    if (typeof input.content !== "string") return;
    const base = existing ?? { notes: new Set(), createdAt: at };
    artifacts.set(id, {
      ...base,
      title: input.title || existing?.title || "",
      type: input.type || existing?.type || "",
      language: input.language || existing?.language || "",
      content: input.content,
      updatedAt: at,
    });
  };
  for (const message of messages) {
    if (message.sender !== "assistant") continue;
    const at = message.created_at ?? null;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === "tool_use" && block.name === "artifacts" && block.input) apply(block.input, at);
    }
    // Older exports kept artifacts inline in the message text.
    const textBlocks = blocks.filter((block) => block?.type === "text").map((block) => block.text ?? "");
    const text = textBlocks.length > 0 ? textBlocks.join("\n") : message.text ?? "";
    for (const match of text.matchAll(/<antArtifact\b([^>]*)>([\s\S]*?)<\/antArtifact>/g)) {
      const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]));
      apply({ command: "create", id: attrs.identifier, type: attrs.type, title: attrs.title, language: attrs.language, content: match[2].replace(/^\n/, "") }, at);
    }
  }
  return [...artifacts.values()];
}

function readClaudeExport(root, source, conversations) {
  const projectsFile = findFiles(root, (name) => name === "projects.json")[0];
  const projects = new Map((projectsFile ? readJson(projectsFile) : []).map((project) => [project.uuid, project.name]));
  // Owners are numbered, never named: an organization export can hold several people's chats.
  const owners = new Map();
  const items = [];
  for (const conversation of conversations) {
    const ownerId = conversation?.account?.uuid;
    if (ownerId && !owners.has(ownerId)) owners.set(ownerId, `owner-${owners.size + 1}`);
    for (const artifact of claudeArtifacts(conversation)) {
      const format = claudeFormat(artifact.type, artifact.language);
      items.push({
        type: "claude-artifact",
        title: artifact.title || conversation.name || "Untitled Claude artifact",
        content: artifact.content,
        format,
        createdAt: toIso(artifact.createdAt) ?? toIso(conversation.created_at),
        originalUrl: conversation.uuid ? `https://claude.ai/chat/${conversation.uuid}` : null,
        conversationTitle: conversation.name || "",
        suggestedProject: projects.get(conversation.project_uuid) ?? null,
        notes: [...artifact.notes, format.note].filter(Boolean),
        exportOwner: owners.get(ownerId) ?? null,
        source,
      });
    }
  }
  return { items, owners: owners.size };
}

/** The messages on the branch the user last saw, oldest first. */
function activeBranch(conversation) {
  const mapping = conversation.mapping ?? {};
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
    if (mapping[nodeId].message) branch.push(mapping[nodeId].message);
    nodeId = mapping[nodeId].parent;
  }
  return branch.reverse();
}

function messageText(message) {
  const content = message?.content ?? {};
  if (typeof content.text === "string") return content.text;
  return (content.parts ?? []).map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
}

/** Applies one canvas edit. Returns false when it cannot be replayed. */
function applyCanvasUpdate(doc, update) {
  const pattern = update?.pattern;
  const replacement = update?.replacement ?? "";
  if (typeof pattern !== "string") return false;
  if (pattern === ".*" || pattern === "^.*$" || pattern === "(?s).*") {
    doc.content = replacement;
    return true;
  }
  try {
    const dotAll = pattern.startsWith("(?s)");
    const regex = new RegExp(dotAll ? pattern.slice(4) : pattern, `${update.multiple ? "g" : ""}${dotAll ? "s" : ""}`);
    if (!regex.test(doc.content)) return false;
    regex.lastIndex = 0;
    doc.content = doc.content.replace(regex, replacement.replace(/\$/g, "$$$$").replace(/\\(\d)/g, "$$$1"));
    return true;
  } catch {
    return false;
  }
}

/** Final versions of the canvas documents on a conversation's active branch. */
function canvasDocuments(conversation) {
  const docs = [];
  let current = null;
  for (const message of activeBranch(conversation)) {
    const role = message.author?.role;
    const textdocId = message.metadata?.canvas?.textdoc_id;
    if (role === "tool" && textdocId && current && !current.id) current.id = textdocId;
    if (role !== "assistant") continue;
    const recipient = message.recipient ?? "";
    if (recipient !== "canmore.create_textdoc" && recipient !== "canmore.update_textdoc") continue;
    let input;
    try {
      input = JSON.parse(messageText(message));
    } catch {
      continue;
    }
    if (recipient === "canmore.create_textdoc") {
      if (typeof input.content !== "string") continue;
      current = { id: null, name: input.name ?? "", type: input.type ?? "document", content: input.content, createdAt: message.create_time, notes: new Set() };
      docs.push(current);
      continue;
    }
    const target = (input.textdoc_id && docs.find((doc) => doc.id === input.textdoc_id)) || current;
    if (!target) continue;
    for (const update of input.updates ?? []) {
      if (!applyCanvasUpdate(target, update)) target.notes.add("An edit could not be replayed; compare with the original");
    }
  }
  return docs;
}

function readChatGptExport(root, source, shards) {
  const items = [];
  for (const shard of shards) {
    const data = readJson(shard);
    const conversations = Array.isArray(data) ? data : data?.conversations ?? [data];
    for (const conversation of conversations) {
      if (!conversation?.mapping) continue;
      const id = conversation.conversation_id ?? conversation.id;
      for (const doc of canvasDocuments(conversation)) {
        const format = canvasFormat(doc.type);
        items.push({
          type: "chatgpt-canvas",
          title: doc.name || conversation.title || "Untitled canvas",
          content: doc.content,
          format,
          createdAt: toIso(doc.createdAt) ?? toIso(conversation.create_time),
          originalUrl: id ? `https://chatgpt.com/c/${id}` : null,
          conversationTitle: conversation.title ?? "",
          suggestedProject: null,
          notes: [...doc.notes, format.note].filter(Boolean),
          source,
        });
      }
    }
  }
  items.push(...chatGptReports(root, source));
  return { items, owners: 1 };
}

/** Generated reports listed in library_files.json, when the file is in the export. */
function chatGptReports(root, source) {
  const library = findFiles(root, (name) => /^library[-_]files\.json$/i.test(name))[0];
  if (!library) return [];
  const files = readdirSync(dirname(library));
  const reports = [];
  for (const entry of readJson(library)) {
    if (entry?.library_artifact_type !== "report" || entry.trashed_at || entry.deleted_at || !entry.file_id) continue;
    const stored = files.find((name) => name.startsWith(entry.file_id));
    if (!stored) continue;
    const path = join(dirname(library), stored);
    const textual = /^text\/|markdown|json/.test(entry.mime_type ?? "");
    const base = {
      type: "chatgpt-report",
      title: entry.file_name || "Untitled report",
      createdAt: toIso(entry.created_at),
      originalUrl: entry.origination_thread_id ? `https://chatgpt.com/c/${entry.origination_thread_id}` : null,
      conversationTitle: "",
      suggestedProject: null,
      notes: ["Found in the ChatGPT library; this export layout is not documented by OpenAI"],
      source,
    };
    if (textual) reports.push({ ...base, content: readFileSync(path, "utf8"), format: { kind: "markdown" } });
    else reports.push({ ...base, filePath: path, contentType: entry.mime_type ?? "application/octet-stream", format: { kind: "file" } });
  }
  return reports;
}

/** The repository folder name above a file, for a project suggestion. */
/**
 * The repository folder name above a file, for a project suggestion. It may
 * look above the source (a docs/ folder inside a repository), but stops
 * below the home folder, so a dotfiles repository there never counts.
 */
function repositoryName(path) {
  const home = homedir();
  let folder = dirname(path);
  while (folder !== home && dirname(folder) !== folder) {
    if (existsSync(join(folder, ".git"))) return basename(folder);
    folder = dirname(folder);
  }
  return null;
}

function documentTitle(text, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const named = frontmatter && /^(?:title|name):\s*["']?(.+?)["']?\s*$/m.exec(frontmatter[1]);
  if (named) return named[1];
  const heading = /^#\s+(.+)$/m.exec(text);
  return heading ? heading[1].trim() : basename(path, extname(path));
}

function parsesAsJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function readDocuments(root, source) {
  // A folder of artifacts downloaded from Claude or ChatGPT also takes code files; a repository folder does not.
  const downloads = source.origin === "claude" || source.origin === "chatgpt";
  const items = [];
  const skipped = [];
  const skip = (path, reason) => skipped.push({ path: relative(root, path) || ".", reason });
  const walk = (folder) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      skip(folder, "Could not be read");
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) walk(path);
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
      const base = {
        type: "document",
        createdAt: stats.mtime.toISOString(),
        originalUrl: null,
        originalPath: path,
        conversationTitle: "",
        suggestedProject: repositoryName(path),
        notes: [],
        source,
      };
      if (stats.size > MAX_FILE_BYTES) {
        skip(path, "Larger than the 25 MB file limit");
        continue;
      }
      if (textFormat) {
        let text;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          skip(path, "Could not be read");
          continue;
        }
        const format = textFormat.kind === "json" && !parsesAsJson(text) ? { kind: "text" } : { ...textFormat };
        items.push({ ...base, title: documentTitle(text, path), content: text, format });
      } else {
        items.push({ ...base, title: basename(path), filePath: path, contentType: fileType, format: { kind: "file" }, notes: ["Binary file: not scanned for secrets; ask the user to check it"] });
      }
    }
  };
  walk(root);
  return { items, owners: 1, skipped };
}

/** Reads one source with the reader its files call for. */
function readSource(source) {
  if (!existsSync(source.path) || !statSync(source.path).isDirectory()) fail(`${source.path} is not a folder. Unzip an export into its own empty folder first.`);
  const conversations = findFiles(source.path, (name) => name === "conversations.json");
  const shards = findFiles(source.path, (name) => /^conversations(?:-\d+)?\.json$/.test(name));
  const claudeLike = conversations.length > 0 && findFiles(source.path, (name) => name === "users.json" || name === "projects.json").length > 0;
  if (claudeLike) {
    const parsed = readJson(conversations[0]);
    if (Array.isArray(parsed) && parsed.some((item) => item?.chat_messages)) {
      return { ...readClaudeExport(source.path, { ...source, origin: source.origin ?? "claude" }, parsed), kind: "claude-export" };
    }
  }
  if (shards.length > 0 && findFiles(source.path, (name) => name === "chat.html" || name === "export_manifest.json" || name === "user.json").length > 0) {
    return { ...readChatGptExport(source.path, { ...source, origin: source.origin ?? "chatgpt" }, shards), kind: "chatgpt-export" };
  }
  return { ...readDocuments(source.path, { ...source, origin: source.origin ?? "files" }), kind: "documents" };
}

function scan(options) {
  if (!options.out) fail("--out is required");
  if (options.sources.length === 0) fail("give at least one --source");
  for (const source of options.sources) {
    if (source.origin && !ORIGINS.has(source.origin)) fail(`--origin must be one of ${[...ORIGINS].join(", ")}`);
    if (options.out === source.path || options.out.startsWith(source.path + sep)) fail("--out must be outside every source folder");
  }
  const itemsDir = join(options.out, "items");
  mkdirSync(itemsDir, { recursive: true });

  const byHash = new Map();
  const report = { sources: [], skipped: [], duplicatesMerged: 0 };
  for (const source of options.sources) {
    const result = readSource(source);
    report.sources.push({ path: source.path, account: source.account, kind: result.kind, items: result.items.length, owners: result.owners });
    report.skipped.push(...(result.skipped ?? []).map((entry) => ({ ...entry, account: source.account })));
    for (const item of result.items) {
      const bytes = item.filePath ? readFileSync(item.filePath) : Buffer.from(item.content, "utf8");
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
      const extension = item.filePath ? extname(item.filePath).toLowerCase() || ".bin" : extensionFor(item.format);
      const path = join("items", `${key}${extension}`);
      if (item.filePath) copyFileSync(item.filePath, join(options.out, path));
      else writeFileSync(join(options.out, path), item.content);
      const sizeBytes = bytes.length;
      const notes = [...item.notes];
      if (!item.filePath && sizeBytes > MAX_TEXT_BYTES) notes.push("Over the 1 MB content limit: upload it as a file or split it");
      byHash.set(hash, {
        key,
        // The hash of the source item. A later redaction changes the file, not this hash or the key.
        sourceSha256: hash,
        title: item.title.slice(0, 160),
        type: item.type,
        origin: item.source.origin,
        accounts: [item.source.account],
        createdAt: item.createdAt,
        sizeBytes,
        format: { kind: item.format.kind, ...(item.format.language ? { language: item.format.language } : {}) },
        contentType: item.contentType ?? null,
        path,
        suggestedProject: item.suggestedProject,
        exportOwner: result.owners > 1 ? item.exportOwner ?? null : null,
        secrets: item.filePath ? [] : scanSecrets(item.content),
        binary: Boolean(item.filePath),
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
  console.log(`\n${inventory.items.length} items, ${inventory.duplicatesMerged} duplicates merged, ${withSecrets} with possible secrets, ${inventory.skipped.length} files skipped.`);
  if (inventory.skipped.some((entry) => entry.reason.startsWith("Looks like conversation"))) {
    console.log("Some skipped files look like a data export the script did not recognise: check that each export is unzipped into its own folder.");
  }
  if (multiOwner > 0) console.log(`${multiOwner} export(s) hold more than one person's conversations: confirm which items the user may import.`);
  console.log(`Inventory: ${join(out, "inventory.json")}`);
}

function redact(options) {
  if (!options.out || !options.key) fail("redact needs --out and --key");
  const inventoryPath = join(options.out, "inventory.json");
  const inventory = readJson(inventoryPath);
  const item = inventory.items.find((entry) => entry.key === options.key);
  if (!item) fail(`no item ${options.key} in ${inventoryPath}`);
  if (item.binary) fail(`${options.key} is a binary file; skip it instead`);
  const path = join(options.out, item.path);
  const redacted = redactText(readFileSync(path, "utf8"), options.rules);
  writeFileSync(path, redacted);
  item.secrets = scanSecrets(redacted);
  item.sizeBytes = Buffer.byteLength(redacted, "utf8");
  item.redacted = true;
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`${options.key}: redacted; ${item.secrets.length} finding(s) left.`);
}

const options = parseArgs(process.argv.slice(2));
if (options.command === "scan") scan(options);
else if (options.command === "redact") redact(options);
else fail("usage: inventory.mjs scan --out <dir> --source <path> [--account <label>] [--origin <name>] ... | redact --out <dir> --key <imp-...>");
