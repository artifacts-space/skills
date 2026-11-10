// Self-check for skills/import-artifacts/scripts/inventory.mjs on synthetic
// exports built in a temporary folder. No real user data, no network.
// Run: node --test tests/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/import-artifacts/scripts/inventory.mjs", import.meta.url));
// Built at runtime so the repository holds no secret-shaped strings.
const fakeKey = ["AKIA", "Z".repeat(16)].join("");
const fakeUrl = ["postgres://app", ":hunter2hunter2", "@db.example.test/app"].join("");

let root;
const write = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
const inventory = (out) => JSON.parse(readFileSync(join(out, "inventory.json"), "utf8"));

function claudeExport(folder, ownerId) {
  write(join(folder, "users.json"), [{ uuid: ownerId, full_name: "Test Person", email_address: "person@example.test" }]);
  write(join(folder, "projects.json"), [{ uuid: "p1", name: "Launch", docs: [] }]);
  write(join(folder, "conversations.json"), [
    {
      uuid: "c1",
      name: "Launch planning",
      created_at: "2025-03-14T10:00:00Z",
      account: { uuid: ownerId },
      project_uuid: "p1",
      chat_messages: [
        { uuid: "m1", sender: "human", created_at: "2025-03-14T10:00:00Z", text: "Write a launch plan", content: [{ type: "text", text: "Write a launch plan" }] },
        {
          uuid: "m2",
          sender: "assistant",
          created_at: "2025-03-14T10:01:00Z",
          content: [{ type: "tool_use", name: "artifacts", input: { command: "create", id: "plan", type: "text/markdown", title: "Launch plan", content: "# Launch plan\n\nShip on Friday." } }],
        },
        {
          uuid: "m3",
          sender: "assistant",
          created_at: "2025-03-14T10:02:00Z",
          content: [{ type: "tool_use", name: "artifacts", input: { command: "update", id: "plan", old_str: "Friday", new_str: "Monday" } }],
        },
      ],
    },
    {
      uuid: "c2",
      name: "Old chat",
      created_at: "2024-06-01T09:00:00Z",
      account: { uuid: ownerId },
      chat_messages: [
        {
          uuid: "m4",
          sender: "assistant",
          created_at: "2024-06-01T09:00:00Z",
          text: 'Here it is.\n<antArtifact identifier="chart" type="image/svg+xml" title="Logo">\n<svg xmlns="http://www.w3.org/2000/svg"></svg></antArtifact>',
          content: [],
        },
      ],
    },
  ]);
}

function chatGptExport(folder) {
  write(join(folder, "user.json"), { id: "user-test" });
  write(join(folder, "chat.html"), "<html></html>");
  const message = (id, parent, role, recipient, body, extra = {}) => ({
    id,
    parent,
    message: { id, author: { role, ...(role === "tool" ? { name: recipient } : {}) }, recipient: role === "tool" ? "all" : recipient, create_time: 1_735_000_000 + Number(id.slice(1)), content: { content_type: "text", parts: [body] }, ...extra },
  });
  write(join(folder, "conversations-000.json"), [
    {
      id: "conv-1",
      title: "Essay help",
      create_time: 1_735_000_000,
      current_node: "n4",
      mapping: {
        root: { id: "root", parent: null, message: null },
        n1: message("n1", "root", "user", "all", "Draft an essay"),
        n2: message("n2", "n1", "assistant", "canmore.create_textdoc", JSON.stringify({ name: "Essay draft", type: "document", content: "Cats are great." })),
        n3: message("n3", "n2", "tool", "canmore.create_textdoc", "Created", { metadata: { canvas: { textdoc_id: "doc-1" } } }),
        n4: message("n4", "n3", "assistant", "canmore.update_textdoc", JSON.stringify({ updates: [{ pattern: "great", replacement: "wonderful", multiple: false }] })),
      },
    },
    {
      id: "conv-2",
      title: "Script help",
      create_time: 1_735_100_000,
      mapping: {
        root: { id: "root", parent: null, message: null },
        n5: message("n5", "root", "assistant", "canmore.create_textdoc", JSON.stringify({ name: "Counter", type: "code/python", content: "count = 1\ncount = 1\n" })),
        n6: message("n6", "n5", "assistant", "canmore.update_textdoc", JSON.stringify({ updates: [{ pattern: "count = (\\d)", replacement: "total = \\1", multiple: true }] })),
        n7: message("n7", "n6", "assistant", "canmore.update_textdoc", JSON.stringify({ updates: [{ pattern: "([", replacement: "x" }] })),
        n8: message("n8", "root", "assistant", "canmore.create_textdoc", JSON.stringify({ name: "Rewritten", type: "document", content: "First draft" })),
        n9: message("n9", "n8", "assistant", "canmore.update_textdoc", JSON.stringify({ updates: [{ pattern: ".*", replacement: "Second draft", multiple: true }] })),
      },
    },
    {},
  ]);
  write(join(folder, "library_files.json"), [
    { file_id: "file_abc", file_name: "Market report", mime_type: "text/markdown", library_artifact_type: "report", created_at: "2026-01-02T00:00:00Z" },
    { file_id: "file_old", file_name: "Deleted report", mime_type: "text/markdown", library_artifact_type: "report", deleted_at: "2026-01-03T00:00:00Z" },
    { file_id: "file_up", file_name: "upload.png", mime_type: "image/png", library_artifact_type: null },
  ]);
  write(join(folder, "file_abc-report.md"), "# Market report\n");
  write(join(folder, "file_old-report.md"), "# Deleted\n");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "import-inventory-"));
  claudeExport(join(root, "claude-personal"), "owner-a");
  claudeExport(join(root, "claude-work"), "owner-b");
  chatGptExport(join(root, "chatgpt"));
  write(join(root, "plans", "rollout.md"), `---\nname: Rollout plan\n---\n\nSet DATABASE_URL to ${fakeUrl}\nkey ${fakeKey}\n`);
  write(join(root, "plans", "notes.json"), "{ not json");
  write(join(root, "plans", ".env"), "SECRET=x");
  write(join(root, "plans", "node_modules", "pkg", "README.md"), "# Not mine");
  write(join(root, "plans", "diagram.pdf"), "%PDF-1.4 synthetic");
  write(join(root, "plans", "page.html"), "<p>repository page</p>");
  write(join(root, "plans", "big.md"), `# Big\n${"x".repeat(1_100_000)}`);
  write(join(root, "plans", "old-export", "conversations.json"), "[]");
  write(join(root, "plans", "session.jsonl"), "{}");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("inventory scan", () => {
  it("should list Claude artifacts, canvases, and documents with their accounts", () => {
    const out = join(root, "out-1");
    run("scan", "--out", out, "--source", join(root, "claude-personal"), "--account", "personal", "--source", join(root, "claude-work"), "--account", "work", "--source", join(root, "chatgpt"), "--account", "personal", "--source", join(root, "plans"), "--origin", "claude-code");
    const { items, duplicatesMerged, skipped } = inventory(out);
    const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));

    assert.equal(byTitle["Launch plan"].format.kind, "markdown");
    assert.match(readFileSync(join(out, byTitle["Launch plan"].path), "utf8"), /Ship on Monday/);
    assert.deepEqual(byTitle["Launch plan"].accounts, ["personal", "work"]);
    assert.equal(byTitle["Launch plan"].suggestedProject, "Launch");
    assert.equal(byTitle["Logo"].format.kind, "svg");
    assert.equal(byTitle["Essay draft"].origin, "chatgpt");
    assert.equal(readFileSync(join(out, byTitle["Essay draft"].path), "utf8"), "Cats are wonderful.");
    assert.equal(duplicatesMerged, 2);
    assert.equal(byTitle["notes"].format.kind, "text");
    assert.ok(skipped.some((entry) => entry.path === ".env"));
    assert.ok(!items.some((item) => item.title === "Not mine"));
  });

  it("should replay canvas edits on the active branch and read library reports", () => {
    const out = join(root, "out-9");
    run("scan", "--out", out, "--source", join(root, "chatgpt"), "--account", "personal");
    const { items, skipped } = inventory(out);
    const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
    // conv-2 has no current_node, so the newest message (n9) picks the branch: only "Rewritten" is on it.
    assert.equal(readFileSync(join(out, byTitle["Rewritten"].path), "utf8"), "Second draft");
    assert.equal(byTitle["Counter"], undefined);
    assert.ok(skipped.some((entry) => /Script help/.test(entry.path) && /1 canvas document\(s\) on an earlier branch/.test(entry.reason)));
    assert.equal(byTitle["Market report"].type, "chatgpt-report");
    assert.equal(byTitle["Deleted report"], undefined);
    assert.equal(byTitle["upload.png"], undefined);
  });

  it("should replay grouped regex edits and flag edits it cannot replay", () => {
    const folder = join(root, "chatgpt-code");
    write(join(folder, "user.json"), { id: "user-test" });
    write(join(folder, "conversations.json"), [
      {
        id: "conv-3",
        title: "Code",
        current_node: "c3",
        mapping: {
          root: { id: "root", parent: null, message: null },
          c1: { id: "c1", parent: "root", message: { author: { role: "assistant" }, recipient: "canmore.create_textdoc", create_time: 1, content: { parts: [JSON.stringify({ name: "Counter", type: "code/python", content: "count = 1\ncount = 2\n" })] } } },
          c2: { id: "c2", parent: "c1", message: { author: { role: "assistant" }, recipient: "canmore.update_textdoc", create_time: 2, content: { parts: [JSON.stringify({ updates: [{ pattern: "count = (\\d)", replacement: "total = \\1", multiple: true }] })] } } },
          c3: { id: "c3", parent: "c2", message: { author: { role: "assistant" }, recipient: "canmore.update_textdoc", create_time: 3, content: { parts: [JSON.stringify({ updates: [{ pattern: "([", replacement: "x" }] })] } } },
        },
      },
    ]);
    const out = join(root, "out-10");
    run("scan", "--out", out, "--source", folder);
    const [item] = inventory(out).items;
    assert.deepEqual(item.format, { kind: "code", language: "python" });
    assert.equal(readFileSync(join(out, item.path), "utf8"), "total = 1\ntotal = 2\n");
    assert.ok(item.notes.some((note) => /could not be replayed/.test(note)));
  });

  it("should list a library file that is not a list as skipped", () => {
    const folder = join(root, "chatgpt-odd-library");
    write(join(folder, "user.json"), { id: "user-test" });
    write(join(folder, "conversations.json"), []);
    write(join(folder, "library_files.json"), { files: [] });
    const out = join(root, "out-12");
    run("scan", "--out", out, "--source", folder);
    assert.ok(inventory(out).skipped.some((entry) => entry.path === "library_files.json" && /Not a list/.test(entry.reason)));
  });

  it("should list unreadable and oversized library reports and unreadable canvases as skipped", () => {
    const folder = join(root, "chatgpt-bad-reports");
    write(join(folder, "user.json"), { id: "user-test" });
    write(join(folder, "conversations.json"), [
      {
        id: "conv-4",
        title: "Broken canvas",
        current_node: "b2",
        mapping: {
          root: { id: "root", parent: null, message: null },
          b0: { id: "b0", parent: "root", message: { author: { role: "assistant" }, recipient: "canmore.create_textdoc", create_time: 1, content: { parts: [JSON.stringify({ name: "Kept", content: "Kept as written" })] } } },
          b1: { id: "b1", parent: "b0", message: { author: { role: "assistant" }, recipient: "canmore.create_textdoc", create_time: 2, content: { parts: ["{ cut off"] } } },
          b2: { id: "b2", parent: "b1", message: { author: { role: "assistant" }, recipient: "canmore.update_textdoc", create_time: 3, content: { parts: [JSON.stringify({ updates: [{ pattern: ".*", replacement: "Meant for the broken canvas" }] })] } } },
        },
      },
    ]);
    write(join(folder, "library_files.json"), [
      { file_id: "file_dir", file_name: "Folder report", mime_type: "text/markdown", library_artifact_type: "report" },
      { file_id: "file_big", file_name: "Huge report", mime_type: "application/pdf", library_artifact_type: "report" },
    ]);
    mkdirSync(join(folder, "file_dir-report.md"));
    write(join(folder, "file_big-report.pdf"), "");
    truncateSync(join(folder, "file_big-report.pdf"), 25 * 1024 * 1024 + 1);
    const out = join(root, "out-13");
    run("scan", "--out", out, "--source", folder);
    const reasons = inventory(out).skipped.map((entry) => entry.reason).join("\n");
    assert.match(reasons, /Report "Folder report" could not be read/);
    assert.match(reasons, /Report "Huge report" is larger than the 25 MB file limit/);
    assert.match(reasons, /1 canvas document\(s\) could not be read/);
    const [kept] = inventory(out).items;
    assert.equal(inventory(out).items.length, 1);
    assert.equal(readFileSync(join(out, kept.path), "utf8"), "Kept as written");
  });

  it("should stop with a message when an export file is cut short", () => {
    const folder = join(root, "chatgpt-truncated");
    write(join(folder, "user.json"), { id: "user-test" });
    write(join(folder, "conversations-000.json"), '[{"id": "conv"');
    assert.throws(() => run("scan", "--out", join(root, "out-11"), "--source", folder), /not complete JSON/);
  });

  it("should never copy account emails into the inventory", () => {
    const out = join(root, "out-2");
    run("scan", "--out", out, "--source", join(root, "claude-personal"), "--account", "personal");
    assert.doesNotMatch(readFileSync(join(out, "inventory.json"), "utf8"), /example\.test/);
  });

  it("should give the same keys when run again", () => {
    const first = join(root, "out-3a");
    const second = join(root, "out-3b");
    run("scan", "--out", first, "--source", join(root, "plans"));
    run("scan", "--out", second, "--source", join(root, "plans"));
    assert.deepEqual(inventory(first).items.map((item) => item.key), inventory(second).items.map((item) => item.key));
  });

  it("should report secrets masked and redact only the extracted copy", () => {
    const out = join(root, "out-4");
    const table = run("scan", "--out", out, "--source", join(root, "plans"), "--origin", "codex");
    const plan = inventory(out).items.find((item) => item.title === "Rollout plan");
    const rules = plan.secrets.map((finding) => finding.rule);
    assert.ok(rules.includes("aws-access-key") && rules.includes("connection-string"));
    assert.doesNotMatch(JSON.stringify(plan.secrets) + table, new RegExp(fakeKey));

    run("redact", "--out", out, "--key", plan.key);
    const after = inventory(out).items.find((item) => item.key === plan.key);
    assert.equal(after.secrets.length, 0);
    assert.doesNotMatch(readFileSync(join(out, after.path), "utf8"), new RegExp(fakeKey));
    assert.match(readFileSync(join(root, "plans", "rollout.md"), "utf8"), new RegExp(fakeKey));
  });

  it("should take code files only from a folder of downloaded artifacts", () => {
    write(join(root, "downloads", "chart.py"), "print('hi')\n");
    const downloads = join(root, "out-5a");
    const repo = join(root, "out-5b");
    run("scan", "--out", downloads, "--source", join(root, "downloads"), "--origin", "claude");
    run("scan", "--out", repo, "--source", join(root, "downloads"), "--origin", "files");
    assert.deepEqual(inventory(downloads).items.map((item) => item.format), [{ kind: "code", language: "python" }]);
    assert.equal(inventory(repo).items.length, 0);
  });

  it("should copy binary files and skip export files, repository HTML, and transcripts", () => {
    const out = join(root, "out-6");
    run("scan", "--out", out, "--source", join(root, "plans"), "--origin", "cursor");
    const { items, skipped } = inventory(out);
    const pdf = items.find((item) => item.title === "diagram.pdf");
    assert.equal(pdf.binary, true);
    assert.equal(pdf.contentType, "application/pdf");
    assert.equal(readFileSync(join(out, pdf.path), "utf8"), "%PDF-1.4 synthetic");
    assert.ok(pdf.notes.some((note) => /not scanned/.test(note)));
    assert.ok(skipped.some((entry) => entry.path === join("old-export", "conversations.json")));
    assert.ok(skipped.some((entry) => entry.path === "session.jsonl"));
    assert.ok(!items.some((item) => item.title === "page"));
    assert.ok(items.find((item) => item.title === "Big").notes.some((note) => /1 MB/.test(note)));
  });

  it("should redact only the rules named with --rules", () => {
    const out = join(root, "out-7");
    run("scan", "--out", out, "--source", join(root, "plans"));
    const plan = inventory(out).items.find((item) => item.title === "Rollout plan");
    run("redact", "--out", out, "--key", plan.key, "--rules", "connection-string");
    const after = inventory(out).items.find((item) => item.key === plan.key);
    assert.ok(!after.secrets.some((finding) => finding.rule === "connection-string"));
    assert.ok(after.secrets.some((finding) => finding.rule === "aws-access-key"));
    assert.equal(after.sourceSha256, plan.sourceSha256);
  });

  it("should reject bad arguments with a message", () => {
    assert.throws(() => run("scan", "--source", join(root, "plans")), /--out is required/);
    assert.throws(() => run("scan", "--out", join(root, "out-8"), "--source", join(root, "plans"), "--origin", "gemini"), /--origin must be one of/);
    assert.throws(() => run("scan", "--account", "work", "--out", join(root, "out-8")), /follow a --source/);
  });

  it("should refuse an output folder inside a source", () => {
    assert.throws(() => run("scan", "--out", join(root, "plans", "out"), "--source", join(root, "plans")), /outside every source/);
    assert.ok(!readdirSync(join(root, "plans")).includes("out"));
  });
});
