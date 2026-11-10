// Self-check for skills/import-artifacts/scripts/inventory.mjs on synthetic
// exports built in a temporary folder. No real user data, no network.
// Run: node --test tests/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    {},
  ]);
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

  it("should refuse an output folder inside a source", () => {
    assert.throws(() => run("scan", "--out", join(root, "plans", "out"), "--source", join(root, "plans")), /outside every source/);
    assert.ok(!readdirSync(join(root, "plans")).includes("out"));
  });
});
