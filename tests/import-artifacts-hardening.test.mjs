// Edge cases for skills/import-artifacts/scripts/inventory.mjs: slow regexes,
// misrouted canvas edits, mixed exports, re-runs, secret rules, agent home
// folders, size and title limits, and malformed exports. Every fixture and
// every fake secret is built at runtime; nothing here is real user data.
// Run: node --test "tests/**/*.test.mjs"

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyCanvasUpdate, documentTitle, fitTitle, redactText, scanSecrets, SECRET_RULES } from "../skills/import-artifacts/scripts/inventory.mjs";

const script = fileURLToPath(new URL("../skills/import-artifacts/scripts/inventory.mjs", import.meta.url));

let root;
const write = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};
const run = (args, env = {}) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
const runError = (args, env = {}) => {
  try {
    run(args, env);
  } catch (error) {
    return String(error.stderr);
  }
  return assert.fail("expected the command to fail");
};
const inventory = (out) => JSON.parse(readFileSync(join(out, "inventory.json"), "utf8"));
const folder = (name) => join(root, name);
const out = (name) => join(root, "out", name);

/** A fake value of `length` characters from `alphabet`, never a real secret. */
const filler = (length, alphabet = "FakeValue0") => alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
const chatGptMessage = (id, parent, role, recipient, body, extra = {}) => ({
  id,
  parent,
  message: { id, author: { role }, recipient, create_time: Number(id.replace(/\D/g, "")) || 1, content: { parts: [typeof body === "string" ? body : JSON.stringify(body)] }, ...extra },
});

before(() => {
  root = mkdtempSync(join(tmpdir(), "import-hardening-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("1. secret scan speed", () => {
  const size = 500_000;
  const inputs = {
    "dash runs": "a-".repeat(size / 2),
    "SVG path data": `<svg><path d="${"M10.5-20.3L30-40c1.2-3.4 5.6-7.8 9-1z".repeat(size / 36)}"/></svg>`,
    base64url: "eyJhbGciOi-_".repeat(size / 12),
    "keyword runs": "password token secret api_key ".repeat(size / 30),
    "scheme runs": "http://a:b".repeat(size / 10),
  };
  for (const [name, text] of Object.entries(inputs)) {
    it(`should scan and redact 500 KB of ${name} in under a second`, () => {
      const started = performance.now();
      scanSecrets(text);
      redactText(text);
      assert.ok(performance.now() - started < 1000, `${name} took ${Math.round(performance.now() - started)} ms`);
    });
  }
});

describe("2. canvas edits", () => {
  it("should drop an edit for an unreadable or unknown canvas instead of rewriting the current one", () => {
    const source = folder("canvas-routing");
    write(join(source, "user.json"), { id: "user-test" });
    write(join(source, "conversations.json"), [
      {
        id: "routing",
        current_node: "m9",
        mapping: {
          root: { id: "root", parent: null, message: null },
          m1: chatGptMessage("m1", "root", "assistant", "canmore.create_textdoc", { name: "Canvas A", content: "A text" }),
          m2: chatGptMessage("m2", "m1", "tool", "all", "Created", { metadata: { canvas: { textdoc_id: "a" } } }),
          m3: chatGptMessage("m3", "m2", "assistant", "canmore.create_textdoc", "{ cut off"),
          m4: chatGptMessage("m4", "m3", "tool", "all", "Created", { metadata: { canvas: { textdoc_id: "b" } } }),
          m5: chatGptMessage("m5", "m4", "assistant", "canmore.create_textdoc", { name: "Canvas C", content: "C text" }),
          m6: chatGptMessage("m6", "m5", "tool", "all", "Created", { metadata: { canvas: { textdoc_id: "c" } } }),
          m7: chatGptMessage("m7", "m6", "assistant", "canmore.update_textdoc", { textdoc_id: "b", updates: [{ pattern: ".*", replacement: "meant for B" }] }),
          m8: chatGptMessage("m8", "m7", "assistant", "canmore.update_textdoc", { textdoc_id: "zzz", updates: [{ pattern: ".*", replacement: "meant for nobody" }] }),
          m9: chatGptMessage("m9", "m8", "assistant", "canmore.update_textdoc", "null"),
        },
      },
    ]);
    run(["scan", "--out", out("canvas-routing"), "--source", source]);
    const { items, skipped } = inventory(out("canvas-routing"));
    const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
    assert.equal(readFileSync(join(out("canvas-routing"), byTitle["Canvas A"].path), "utf8"), "A text");
    assert.equal(readFileSync(join(out("canvas-routing"), byTitle["Canvas C"].path), "utf8"), "C text");
    assert.ok(byTitle["Canvas C"].notes.some((note) => /could not be replayed/.test(note)), "the null edit body is noted on the canvas it targeted");
    assert.ok(skipped.some((entry) => /1 canvas edit\(s\) matched no canvas/.test(entry.reason)));
    assert.ok(skipped.some((entry) => /1 canvas document\(s\) could not be read/.test(entry.reason)));
  });

  it("should note a null update instead of failing", () => {
    const doc = { content: "text", notes: new Set() };
    assert.equal(applyCanvasUpdate(doc, null), false);
    assert.equal(applyCanvasUpdate(doc, { pattern: null }), false);
    assert.equal(doc.content, "text");
  });

  it("should translate Python-only regex syntax", () => {
    const doc = { content: "alpha beta", notes: new Set() };
    assert.equal(applyCanvasUpdate(doc, { pattern: String.raw`\A(?P<first>\w+)`, replacement: String.raw`\g<first>!`, multiple: false }), true);
    assert.equal(doc.content, "alpha! beta");
    assert.equal(applyCanvasUpdate(doc, { pattern: String.raw`(\w+)\Z`, replacement: String.raw`[\g<1>]`, multiple: false }), true);
    assert.equal(doc.content, "alpha! [beta]");
    assert.equal(applyCanvasUpdate(doc, { pattern: "(?x) a b", replacement: "" }), false, "verbose mode is not replayed");
  });
});

describe("3. several exports in one source", () => {
  it("should refuse the source and name each export folder", () => {
    const source = folder("two-exports");
    write(join(source, "personal", "users.json"), []);
    write(join(source, "personal", "conversations.json"), [{ uuid: "c", chat_messages: [] }]);
    write(join(source, "work", "user.json"), {});
    write(join(source, "work", "conversations.json"), [{ id: "x", mapping: {} }]);
    const message = runError(["scan", "--out", out("two-exports"), "--source", source]);
    assert.match(message, /holds 2 exports \(personal, work\)/);
  });

  it("should list files beside a nested export instead of dropping them silently", () => {
    const source = folder("export-and-notes");
    write(join(source, "export", "users.json"), []);
    write(join(source, "export", "conversations.json"), []);
    write(join(source, "notes.md"), "# Notes\n");
    run(["scan", "--out", out("export-and-notes"), "--source", source]);
    assert.ok(inventory(out("export-and-notes")).skipped.some((entry) => entry.path === "notes.md" && /its own --source/.test(entry.reason)));
  });
});

describe("4. re-running into the same --out", () => {
  it("should keep a redaction when the scan runs again", () => {
    const source = folder("rerun");
    write(join(source, "plan.md"), `# Plan\n\nAPI_KEY=${filler(24)}\n`);
    const target = out("rerun");
    run(["scan", "--out", target, "--source", source]);
    const [item] = inventory(target).items;
    run(["redact", "--out", target, "--key", item.key]);
    run(["scan", "--out", target, "--source", source]);
    const [again] = inventory(target).items;
    assert.equal(again.key, item.key);
    assert.equal(again.redacted, true);
    assert.equal(again.secrets.length, 0);
    assert.doesNotMatch(readFileSync(join(target, again.path), "utf8"), new RegExp(filler(24)));
  });

  it("should refuse an --out that holds other files", () => {
    const target = out("not-empty");
    write(join(target, "keep.txt"), "mine");
    assert.match(runError(["scan", "--out", target, "--source", folder("rerun")]), /not empty and holds no inventory\.json/);
  });
});

describe("5. secret rules", () => {
  const cases = {
    "private-key": ["-----BEGIN OPENSSH PRIVATE KEY-----\n", `${filler(64, "QUJD")}\n-----END OPENSSH PRIVATE KEY-----`],
    "pgp-private-key": ["-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n", `${filler(64, "QUJD")}\n${filler(40, "RUZH")}`],
    "aws-access-key": ["AKIA", filler(16, "FAKE0")],
    "github-token": ["ghp_", filler(36)],
    "gitlab-token": ["glpat-", filler(20)],
    "npm-token": ["npm_", filler(36)],
    "huggingface-token": ["hf_", filler(34)],
    "sendgrid-key": ["SG.", `${filler(22)}.${filler(43)}`],
    "supabase-secret-key": ["sb_secret_", filler(24)],
    "anthropic-key": ["sk-ant-", filler(40)],
    "openai-key": ["sk-proj-", filler(40)],
    "stripe-key": [["sk", "live", ""].join("_"), filler(24)],
    "stripe-webhook-secret": ["whsec_", filler(32)],
    "slack-token": ["xoxp-", `1234-5678-${filler(20)}`],
    "slack-app-token": ["xapp-", `1-${filler(20)}`],
    "slack-webhook": ["https://hooks.slack.com/services/", `T0000/B0000/${filler(24)}`],
    "google-api-key": ["AIza", filler(35)],
    jwt: ["eyJ", `${filler(20)}.eyJ${filler(30)}.${filler(20)}`],
    "bearer-token": ["Authorization: Bearer ", filler(32)],
    "connection-string": ["redis://:", `${filler(16)}@cache.example.test:6379`],
    "env-secret": ["STRIPE_SECRET_KEY=", filler(20)],
    "env-password": ["DB_PASSWORD=", filler(12)],
    "secret-assignment": ['password: "', `${filler(14)}"`],
  };
  const expectedRule = { "pgp-private-key": "private-key", "slack-app-token": "slack-token", "env-password": "env-secret" };

  it("should cover every rule in the script", () => {
    const tested = new Set(Object.keys(cases).map((name) => expectedRule[name] ?? name));
    assert.deepEqual([...SECRET_RULES.map((entry) => entry.name)].filter((name) => !tested.has(name)), []);
  });

  for (const [name, [prefix, secret]] of Object.entries(cases)) {
    it(`should find, mask, and redact ${name}`, () => {
      const text = `Notes before.\n${prefix}${secret}\nNotes after.\n`;
      const { findings } = scanSecrets(text);
      const finding = findings.find((entry) => entry.rule === (expectedRule[name] ?? name));
      assert.ok(finding, `no ${name} finding in ${JSON.stringify(findings)}`);
      assert.equal(finding.line, 2);
      const body = secret.slice(4, 16);
      assert.ok(!JSON.stringify(findings).includes(body), `${name} preview shows the secret: ${finding.preview}`);
      const redacted = redactText(text);
      assert.ok(!redacted.includes(body), `${name} survived redaction`);
      assert.equal(scanSecrets(redacted).findings.length, 0);
      assert.match(redacted, /Notes after\./);
    });
  }

  it("should keep the variable name when it redacts an assignment", () => {
    assert.equal(redactText(`API_KEY=${filler(20)}\n`), "API_KEY=[REDACTED:env-secret]\n");
    assert.equal(redactText(`postgres://app:${filler(12)}@db.example.test/app`), "postgres://[REDACTED:connection-string]@db.example.test/app");
  });

  it("should refuse an unknown --rules name", () => {
    const source = folder("rules");
    write(join(source, "plan.md"), `# Plan\n\nAPI_KEY=${filler(24)}\n`);
    run(["scan", "--out", out("rules"), "--source", source]);
    const [item] = inventory(out("rules")).items;
    assert.match(runError(["redact", "--out", out("rules"), "--key", item.key, "--rules", "aws-key"]), /unknown rule\(s\) aws-key/);
  });
});

describe("6. coding-agent home folders", () => {
  it("should read only plans/ inside ~/.claude", () => {
    const home = folder("home");
    const claude = join(home, ".claude");
    write(join(claude, "plans", "rollout.md"), "# Rollout\n");
    write(join(claude, "projects", "repo", "memory", "notes.md"), "# Memory\n");
    write(join(claude, "projects", "repo", "abc", "tool-results", "out.txt"), "tool output");
    write(join(claude, "todos", "list.json"), "[]");
    write(join(claude, "settings.json"), "{}");
    write(join(claude, "CLAUDE.md"), "# Rules\n");
    run(["scan", "--out", out("claude-home"), "--source", claude, "--origin", "claude-code"], { HOME: home });
    const { items, skipped } = inventory(out("claude-home"));
    assert.deepEqual(items.map((item) => item.title), ["Rollout"]);
    assert.ok(skipped.some((entry) => /only plans\/ is/.test(entry.reason)));
  });

  it("should read nothing from a session folder inside ~/.codex", () => {
    const home = folder("home");
    write(join(home, ".codex", "sessions", "2026", "plan.md"), "# Not a plan\n");
    run(["scan", "--out", out("codex-sessions"), "--source", join(home, ".codex", "sessions"), "--origin", "codex"], { HOME: home });
    const { items, skipped } = inventory(out("codex-sessions"));
    assert.equal(items.length, 0);
    assert.match(skipped[0].reason, /session data or settings/);
  });
});

describe("7. huge exports", () => {
  it("should say an oversized conversations.json is too large instead of asking for a new download", () => {
    const source = folder("huge");
    write(join(source, "users.json"), []);
    write(join(source, "conversations.json"), "");
    truncateSync(join(source, "conversations.json"), 501 * 1024 * 1024);
    assert.match(runError(["scan", "--out", out("huge"), "--source", source]), /too large for this helper/);
  });
});

describe("8. size limits", () => {
  it("should flag content over 1,000,000 characters even under 1 MiB", () => {
    const source = folder("size");
    write(join(source, "long.md"), `# Long\n${"x".repeat(1_000_000)}`);
    write(join(source, "short.md"), "# Short\n");
    run(["scan", "--out", out("size"), "--source", source]);
    const byTitle = Object.fromEntries(inventory(out("size")).items.map((item) => [item.title, item]));
    assert.ok(byTitle.Long.sizeBytes < 1_048_576);
    assert.equal(byTitle.Long.uploadAs, ".md");
    assert.equal(byTitle.Short.uploadAs, undefined);
  });

  it("should send oversized code up as a .txt file", () => {
    const source = folder("size-code");
    write(join(source, "page.html"), `<p>${"x".repeat(1_000_001)}</p>`);
    run(["scan", "--out", out("size-code"), "--source", source, "--origin", "claude"]);
    const [item] = inventory(out("size-code")).items;
    assert.equal(item.uploadAs, ".txt");
    assert.ok(item.notes.some((note) => /upload it as a \.txt file/.test(note)));
  });
});

describe("9. titles", () => {
  it("should cut long titles to 160 characters and keep the full one", () => {
    const { title, fullTitle } = fitTitle("T".repeat(200), "Fallback");
    assert.equal(title.length, 160);
    assert.equal(fullTitle.length, 200);
  });

  it("should never give an empty or wrong title", () => {
    assert.equal(fitTitle("   ", "Fallback").title, "Fallback");
    assert.equal(fitTitle('""', "Fallback").title, "Fallback");
    assert.equal(documentTitle("#   \n\nBody", "/docs/heading.md"), "heading");
    assert.equal(documentTitle('---\ntitle: ""\n---\n# Real heading\n', "/docs/front.md"), "Real heading");
    assert.equal(documentTitle("#\n\nSecond line", "/docs/crossing.md"), "crossing");
  });
});

describe("10. library reports", () => {
  it("should match report files by exact id and skip symlinks and export files", () => {
    const source = folder("library");
    write(join(source, "user.json"), {});
    write(join(source, "conversations.json"), []);
    write(join(source, "file_ab-other.md"), "# Not this one\n");
    write(join(source, "file_abc-report.md"), "# The right report\n");
    write(join(root, "outside.md"), "# Outside the export\n");
    symlinkSync(join(root, "outside.md"), join(source, "file_link-report.md"));
    write(join(source, "library_files.json"), [
      { file_id: "file_ab", file_name: "Short id", mime_type: "text/markdown", library_artifact_type: "report" },
      { file_id: "file_abc", file_name: "Right report", mime_type: "text/markdown", library_artifact_type: "report" },
      { file_id: "file_link", file_name: "Linked report", mime_type: "text/markdown", library_artifact_type: "report" },
      { file_id: "conversations", file_name: "Sneaky report", mime_type: "application/json", library_artifact_type: "report" },
    ]);
    run(["scan", "--out", out("library"), "--source", source]);
    const { items, skipped } = inventory(out("library"));
    const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
    assert.equal(readFileSync(join(out("library"), byTitle["Right report"].path), "utf8"), "# The right report\n");
    assert.equal(readFileSync(join(out("library"), byTitle["Short id"].path), "utf8"), "# Not this one\n");
    assert.equal(byTitle["Linked report"], undefined);
    assert.equal(byTitle["Sneaky report"], undefined);
    assert.ok(skipped.some((entry) => /"Linked report" is not a regular file/.test(entry.reason)));
    assert.ok(skipped.some((entry) => /"Sneaky report" points at export or credential data/.test(entry.reason)));
  });
});

describe("11. output folder guard", () => {
  before(() => {
    write(join(folder("guarded"), "plan.md"), "# Plan\n");
    symlinkSync(folder("guarded"), folder("guarded-link"));
  });

  it("should refuse an --out reached through a symlink into the source", () => {
    const source = folder("guarded");
    assert.match(runError(["scan", "--out", join(folder("guarded-link"), "inventory"), "--source", source]), /outside every source/);
  });

  it("should refuse a differently cased --out on a case-insensitive file system", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => {
    assert.match(runError(["scan", "--out", join(folder("guarded").toUpperCase(), "inventory"), "--source", folder("guarded")]), /outside every source/);
  });

  it("should never read an earlier inventory folder as documents", () => {
    const source = folder("with-inventory");
    write(join(source, "plan.md"), "# Plan\n");
    run(["scan", "--out", join(root, "staging"), "--source", source]);
    run(["scan", "--out", join(source, "old-run-copy"), "--source", folder("guarded")]);
    run(["scan", "--out", out("with-inventory"), "--source", source]);
    const { items, skipped } = inventory(out("with-inventory"));
    assert.deepEqual(items.map((item) => item.title), ["Plan"]);
    assert.ok(skipped.some((entry) => entry.path === "old-run-copy" && /earlier import inventory/.test(entry.reason)));
  });
});

describe("12. a Claude export wrapped in an object", () => {
  it("should read conversations under a `conversations` key", () => {
    const source = folder("claude-wrapped");
    write(join(source, "users.json"), []);
    write(join(source, "conversations.json"), {
      conversations: [{ uuid: "w", chat_messages: [{ sender: "assistant", created_at: "2025-01-01T00:00:00Z", content: [{ type: "tool_use", name: "artifacts", input: { command: "create", id: "a", type: "text/markdown", title: "Wrapped", content: "# Wrapped" } }] }] }],
    });
    run(["scan", "--out", out("claude-wrapped"), "--source", source]);
    assert.deepEqual(inventory(out("claude-wrapped")).items.map((item) => item.title), ["Wrapped"]);
  });
});

describe("12-14. malformed Claude exports, message order, and untitled artifacts", () => {
  it("should report malformed entries, replay edits in real time order, and never use the conversation name as a title", () => {
    const source = folder("claude-odd");
    write(join(source, "users.json"), []);
    write(join(source, "projects.json"), { not: "a list" });
    write(join(source, "conversations.json"), [
      null,
      { uuid: "broken", chat_messages: null },
      {
        uuid: "ordered",
        name: "Private conversation name",
        chat_messages: [
          null,
          // 09:00Z sorts after 10:02+02:00 (08:02Z) in real time, but before it as a string.
          { sender: "assistant", created_at: "2025-03-14T09:00:00Z", content: [{ type: "tool_use", name: "artifacts", input: { command: "update", id: "a", old_str: "draft", new_str: "final" } }] },
          { sender: "assistant", created_at: "2025-03-14T10:02:00+02:00", content: [null, { type: "tool_use", name: "artifacts", input: { command: "create", id: "a", type: "text/markdown", content: "the draft" } }] },
          { sender: "assistant", created_at: "2025-03-14T09:30:00Z", content: [{ type: "tool_use", name: "artifacts", input: { command: "update", id: "ghost", old_str: "x", new_str: "y" } }] },
        ],
      },
    ]);
    run(["scan", "--out", out("claude-odd"), "--source", source]);
    const { items, skipped } = inventory(out("claude-odd"));
    assert.equal(items.length, 1);
    assert.equal(readFileSync(join(out("claude-odd"), items[0].path), "utf8"), "the final");
    assert.equal(items[0].title, "Untitled artifact (2025-03-14)");
    assert.ok(!JSON.stringify(items[0].title).includes("Private conversation name"));
    const reasons = skipped.map((entry) => entry.reason).join("\n");
    assert.match(reasons, /Not a list of projects/);
    assert.match(reasons, /1 empty conversation entries/);
    assert.match(reasons, /1 artifact edit\(s\) refer to an artifact that is not in the export/);
  });
});

describe("15. skipped folders", () => {
  it("should list build and dependency folders as skipped", () => {
    const source = folder("repo");
    write(join(source, "docs", "plan.md"), "# Plan\n");
    write(join(source, "node_modules", "pkg", "README.md"), "# Package\n");
    write(join(source, "dist", "notes.md"), "# Built\n");
    run(["scan", "--out", out("repo"), "--source", source]);
    const { items, skipped } = inventory(out("repo"));
    assert.deepEqual(items.map((item) => item.title), ["Plan"]);
    assert.deepEqual(skipped.filter((entry) => /Build or dependency/.test(entry.reason)).map((entry) => entry.path).sort(), ["dist", "node_modules"]);
  });
});
