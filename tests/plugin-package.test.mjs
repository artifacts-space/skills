// Self-check for scripts/plugin-rules.mjs and scripts/build-openai-zip.mjs.
// Each test copies the repository's package files into a temporary folder and
// breaks one thing. No network.
// Run: node --test tests/

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPluginPackage, DEMO_PLACEHOLDER, findTokens, isAllowedUrl, PLUGIN_DIR, readmeWords } from "../scripts/plugin-rules.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const buildScript = join(repo, "scripts", "build-openai-zip.mjs");
const COPIED = ["LICENSE", "skills", "plugins", "gemini-extension.json", ".cursor-plugin"];
const made = [];

after(() => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true });
});

/** Copies the package files into a fresh temporary repository root. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plugin-package-"));
  made.push(root);
  for (const entry of COPIED) cpSync(join(repo, entry), join(root, entry), { recursive: true });
  return root;
}

const plugin = (root, ...parts) => join(root, PLUGIN_DIR, ...parts);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const editJson = (path, change) => {
  const json = readJson(path);
  change(json);
  writeJson(path, json);
};
const openAi = (json) => json.extensions["com.openai"];
const hasProblem = (problems, pattern) => problems.some((problem) => pattern.test(problem));

/** A PNG header with the given size; the rules read only the IHDR chunk. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("the package in this repository", () => {
  it("should pass the normal check", () => {
    assert.deepEqual(checkPluginPackage(repo), []);
  });

  it("should fail the release check only on the demo video placeholder when no video URL is set", () => {
    const problems = checkPluginPackage(repo, { release: true });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /demo_recording_url is still REPLACE_WITH_DEMO_VIDEO_URL/);
  });

  it("should pass the release check when the demo video URL is https", () => {
    const root = fixture();
    editJson(plugin(root, "plugin.json"), (json) => {
      openAi(json).review.demo_recording_url = "https://videos.example.test/demo";
    });
    assert.deepEqual(checkPluginPackage(root, { release: true }), []);
  });

  it("should fail when the demo video URL is not https", () => {
    const root = fixture();
    editJson(plugin(root, "plugin.json"), (json) => {
      openAi(json).review.demo_recording_url = "http://videos.example.test/demo";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /demo_recording_url must be an https URL/));
  });
});

describe("skill copies", () => {
  it("should fail when the plugin's skill differs from skills/artifacts-space", () => {
    const root = fixture();
    writeFileSync(plugin(root, "skills", "artifacts-space", "SKILL.md"), `${readFileSync(join(root, "skills", "artifacts-space", "SKILL.md"), "utf8")}\nExtra line.\n`);
    assert.ok(hasProblem(checkPluginPackage(root), /SKILL\.md: differs from skills\/artifacts-space/));
  });

  it("should fail when the plugin's skill has a file the source lacks", () => {
    const root = fixture();
    writeFileSync(plugin(root, "skills", "artifacts-space", "notes.md"), "Only in the copy.\n");
    assert.ok(hasProblem(checkPluginPackage(root), /notes\.md: not in skills\/artifacts-space/));
  });

  it("should fail when the plugin has no artifacts-space skill", () => {
    const root = fixture();
    rmSync(plugin(root, "skills", "artifacts-space"), { recursive: true });
    assert.ok(hasProblem(checkPluginPackage(root), /skills\/artifacts-space: missing/));
  });
});

describe("manifests agree", () => {
  it("should fail when one manifest has another version", () => {
    const root = fixture();
    editJson(join(root, "gemini-extension.json"), (json) => {
      json.version = "1.0.1";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /^version differs across/));
  });

  it("should fail when a version is not semantic", () => {
    const root = fixture();
    for (const file of [plugin(root, "plugin.json"), plugin(root, ".claude-plugin", "plugin.json"), join(root, "gemini-extension.json")]) {
      editJson(file, (json) => {
        json.version = "v1";
      });
    }
    editJson(join(root, ".cursor-plugin", "marketplace.json"), (json) => {
      json.plugins[0].version = "v1";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /version must look like 1\.2\.3/));
  });

  it("should fail when the Claude manifest's description drifts", () => {
    const root = fixture();
    editJson(plugin(root, ".claude-plugin", "plugin.json"), (json) => {
      json.description = "Something else.";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /^description differs across/));
  });
});

describe("required fields", () => {
  it("should fail when a manifest is not valid JSON", () => {
    const root = fixture();
    writeFileSync(plugin(root, "mcp.json"), "{ not json");
    assert.ok(hasProblem(checkPluginPackage(root), /mcp\.json: not valid JSON/));
  });

  it("should fail when the OpenAI listing lacks its support URL", () => {
    const root = fixture();
    editJson(plugin(root, "plugin.json"), (json) => {
      delete openAi(json).interface.supportURL;
    });
    assert.ok(hasProblem(checkPluginPackage(root), /missing interface\.supportURL/));
  });

  it("should fail when the short description is over 30 characters", () => {
    const root = fixture();
    editJson(plugin(root, "plugin.json"), (json) => {
      openAi(json).interface.shortDescription = "Save and share the work of every agent";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /shortDescription is \d+ characters; keep it to 30/));
  });

  it("should fail when there are not exactly five positive test cases", () => {
    const root = fixture();
    editJson(plugin(root, "plugin.json"), (json) => {
      openAi(json).review.test_cases.positive.pop();
    });
    assert.ok(hasProblem(checkPluginPackage(root), /positive needs exactly 5 cases/));
  });

  it("should fail when reviewer credentials are put in the package", () => {
    const root = fixture();
    editJson(plugin(root, "plugin.json"), (json) => {
      openAi(json).review.test_credentials = { email: "reviewer@example.test" };
    });
    assert.ok(hasProblem(checkPluginPackage(root), /review\.test_credentials is not allowed/));
  });

  it("should fail when the Agent Plugins manifest has a field the schema rejects", () => {
    const root = fixture();
    editJson(plugin(root, "plugin.json"), (json) => {
      json.logo = "./assets/logo.png";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /plugin\.json: unknown field logo/));
  });

  it("should fail when the author is not Webrenew LLC", () => {
    const root = fixture();
    editJson(plugin(root, ".claude-plugin", "plugin.json"), (json) => {
      json.author.name = "Someone Else";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /author\.name must be "Webrenew LLC"/));
  });
});

describe("MCP servers", () => {
  it("should fail when a server carries headers", () => {
    const root = fixture();
    editJson(plugin(root, ".mcp.json"), (json) => {
      json.mcpServers.artifacts.headers = { Authorization: "Bearer YOUR_TOKEN" };
    });
    assert.ok(hasProblem(checkPluginPackage(root), /\.mcp\.json: unknown field mcpServers\.artifacts\.headers/));
  });

  it("should fail when the portable mcp.json carries a client extension the schema rejects", () => {
    const root = fixture();
    editJson(plugin(root, "mcp.json"), (json) => {
      json.mcpServers.artifacts.extensions = { "com.openai": { auth: { type: "oauth" } } };
    });
    assert.ok(hasProblem(checkPluginPackage(root), /mcp\.json: unknown field mcpServers\.artifacts\.extensions/));
  });

  it("should fail when the Claude server type is not http", () => {
    const root = fixture();
    editJson(plugin(root, ".mcp.json"), (json) => {
      json.mcpServers.artifacts.type = "streamable-http";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /\.mcp\.json: mcpServers\.artifacts\.type must be "http"/));
  });

  it("should fail when the Gemini extension points at another endpoint", () => {
    const root = fixture();
    editJson(join(root, "gemini-extension.json"), (json) => {
      json.mcpServers.artifacts = { url: "https://artifacts.space/api/mcp" };
    });
    const problems = checkPluginPackage(root);
    assert.ok(hasProblem(problems, /gemini-extension\.json: mcpServers\.artifacts\.httpUrl must be/));
  });
});

describe("URLs", () => {
  it("should accept https URLs on artifacts.space and this repository", () => {
    assert.equal(isAllowedUrl("https://artifacts.space/privacy"), true);
    assert.equal(isAllowedUrl("https://github.com/artifacts-space/skills"), true);
  });

  it("should reject http, other hosts, look-alike repositories, and embedded credentials", () => {
    assert.equal(isAllowedUrl("http://artifacts.space/privacy"), false);
    assert.equal(isAllowedUrl("https://artifacts.space.example.test/"), false);
    assert.equal(isAllowedUrl("https://github.com/artifacts-space/skills-fork"), false);
    assert.equal(isAllowedUrl("https://user:pass@artifacts.space/"), false);
  });

  it("should fail when a listing URL leaves artifacts.space", () => {
    const root = fixture();
    editJson(plugin(root, ".claude-plugin", "plugin.json"), (json) => {
      json.supportUrl = "https://support.example.test";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /supportUrl "https:\/\/support\.example\.test" must be an https URL on artifacts\.space/));
  });
});

describe("icons", () => {
  it("should fail when an icon is not square", () => {
    const root = fixture();
    writeFileSync(plugin(root, "assets", "icon.png"), pngHeader(128, 64));
    assert.ok(hasProblem(checkPluginPackage(root), /interface\.composerIcon is 128x64; it must be square/));
  });

  it("should fail when an icon is smaller than 48 px", () => {
    const root = fixture();
    writeFileSync(plugin(root, "assets", "logo.png"), pngHeader(32, 32));
    assert.ok(hasProblem(checkPluginPackage(root), /interface\.logo is 32 px wide; use 48 to 4096 px/));
  });

  it("should fail when an icon path does not exist", () => {
    const root = fixture();
    rmSync(plugin(root, "assets", "logo.png"));
    assert.ok(hasProblem(checkPluginPackage(root), /icon "\.\/assets\/logo\.png" does not exist/));
  });

  it("should fail when an icon path climbs out of the plugin", () => {
    const root = fixture();
    editJson(plugin(root, ".claude-plugin", "plugin.json"), (json) => {
      json.icon = "../../LICENSE";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /icon must stay inside/));
  });
});

describe("files in the plugin folder", () => {
  it("should fail when a system file is present", () => {
    const root = fixture();
    writeFileSync(plugin(root, ".DS_Store"), "");
    assert.ok(hasProblem(checkPluginPackage(root), /\.DS_Store: remove this system file/));
  });

  it("should fail when a file is a symbolic link", () => {
    const root = fixture();
    symlinkSync(join(root, "LICENSE"), plugin(root, "COPYING"));
    assert.ok(hasProblem(checkPluginPackage(root), /COPYING: symbolic links are not allowed/));
  });

  it("should fail when the README is under 40 words outside code blocks", () => {
    const root = fixture();
    writeFileSync(plugin(root, "README.md"), "# artifacts.space\n\nShort.\n\n```bash\none two three four five six seven eight nine ten\n```\n");
    assert.ok(hasProblem(checkPluginPackage(root), /README\.md: needs at least 40 words/));
  });

  it("should fail when the plugin's LICENSE differs from the repository's", () => {
    const root = fixture();
    writeFileSync(plugin(root, "LICENSE"), "All rights reserved.\n");
    assert.ok(hasProblem(checkPluginPackage(root), /LICENSE: differs from LICENSE/));
  });

  it("should count README words outside code blocks only", () => {
    assert.equal(readmeWords("one two\n```\nthree four\n```\nfive"), 3);
  });
});

describe("credentials", () => {
  // Built at runtime so the repository holds no secret-shaped strings.
  const fakeToken = ["artifacts", "_oat_", "Q7xR2kLm9TzP4vNw8YbC3dFh"].join("");
  const fakeGithub = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

  it("should flag token-shaped strings", () => {
    assert.ok(findTokens(`Authorization: Bearer ${fakeToken}`).length > 0);
    assert.ok(findTokens(`token = ${fakeGithub}`).some((finding) => finding.startsWith("GitHub token")));
  });

  it("should not flag tool names or the documented placeholders", () => {
    assert.deepEqual(findTokens("Call artifacts_restore_version, then artifacts_formats_guide."), []);
    assert.deepEqual(findTokens('"Authorization": "Bearer YOUR_TOKEN"'), []);
    assert.deepEqual(findTokens('--header "Authorization: Bearer $ARTIFACTS_SPACE_TOKEN"'), []);
  });

  it("should fail when a plugin file holds a token", () => {
    const root = fixture();
    writeFileSync(plugin(root, "README.md"), `${readFileSync(plugin(root, "README.md"), "utf8")}\nToken: ${fakeToken}\n`);
    assert.ok(hasProblem(checkPluginPackage(root), /README\.md: looks like a real credential \(artifacts\.space token/));
  });
});

describe("cursor marketplace", () => {
  it("should fail when the marketplace points at another folder", () => {
    const root = fixture();
    editJson(join(root, ".cursor-plugin", "marketplace.json"), (json) => {
      json.plugins[0].source = "plugins/other";
    });
    assert.ok(hasProblem(checkPluginPackage(root), /plugins\[0\]\.source must be "plugins\/artifacts-space"/));
  });
});

const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;

describe("OpenAI ZIP build", { skip: hasZip ? false : "zip is not installed" }, () => {
  it("should refuse a release build while the demo video URL is the placeholder", () => {
    const out = mkdtempSync(join(tmpdir(), "openai-zip-"));
    made.push(out);
    const result = spawnSync(process.execPath, [buildScript, "--out", out], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(DEMO_PLACEHOLDER));
  });

  it("should build a draft ZIP with the plugin at its root and without the Claude files", () => {
    const out = mkdtempSync(join(tmpdir(), "openai-zip-"));
    made.push(out);
    execFileSync(process.execPath, [buildScript, "--draft", "--out", out], { encoding: "utf8" });
    const { version } = readJson(join(repo, PLUGIN_DIR, "plugin.json"));
    const zip = join(out, `artifacts-space-openai-${version}-draft.zip`);
    const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const entry of ["plugin.json", "mcp.json", "README.md", "LICENSE", "skills/artifacts-space/SKILL.md", "assets/logo.png", "assets/icon.png"]) {
      assert.ok(listing.includes(entry), `${entry} is in the ZIP`);
    }
    assert.ok(!listing.some((entry) => entry.startsWith(".claude-plugin") || entry === ".mcp.json"));
    const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "plugin.json"], { encoding: "utf8" }));
    assert.equal("demo_recording_url" in manifest.extensions["com.openai"].review, false);
  });

  it("should package the repository's mcp.json byte for byte, with no extensions key", () => {
    const out = mkdtempSync(join(tmpdir(), "openai-zip-"));
    made.push(out);
    execFileSync(process.execPath, [buildScript, "--draft", "--out", out], { encoding: "utf8" });
    const { version } = readJson(join(repo, PLUGIN_DIR, "plugin.json"));
    const packaged = execFileSync("unzip", ["-p", join(out, `artifacts-space-openai-${version}-draft.zip`), "mcp.json"]);
    assert.ok(packaged.equals(readFileSync(join(repo, PLUGIN_DIR, "mcp.json"))), "packaged mcp.json equals the repository's");
    assert.doesNotMatch(packaged.toString("utf8"), /"extensions"/);
    // The packaged file passes the same rules as the repository copy.
    const root = fixture();
    writeFileSync(plugin(root, "mcp.json"), packaged);
    assert.deepEqual(checkPluginPackage(root), []);
  });

  it("should build a release ZIP that keeps the demo video URL and has no -draft in its name", () => {
    const root = fixture();
    cpSync(join(repo, "scripts"), join(root, "scripts"), { recursive: true });
    const demoUrl = "https://videos.example.com/artifacts-space/plugin-demo.mp4";
    editJson(plugin(root, "plugin.json"), (json) => {
      openAi(json).review.demo_recording_url = demoUrl;
    });
    const { version } = readJson(plugin(root, "plugin.json"));
    const out = mkdtempSync(join(tmpdir(), "openai-zip-"));
    made.push(out);
    const stdout = execFileSync(process.execPath, [join(root, "scripts", "build-openai-zip.mjs"), "--out", out], { encoding: "utf8" });
    assert.deepEqual(readdirSync(out), [`artifacts-space-openai-${version}.zip`]);
    assert.doesNotMatch(stdout, /draft/);
    assert.match(stdout, /install this ZIP in a current Codex or ChatGPT build and check that the artifacts MCP server loads/);
    const manifest = JSON.parse(execFileSync("unzip", ["-p", join(out, `artifacts-space-openai-${version}.zip`), "plugin.json"], { encoding: "utf8" }));
    assert.equal(openAi(manifest).review.demo_recording_url, demoUrl);
  });

  for (const [label, args] of [
    ["is followed by another flag", ["--out", "--draft"]],
    ["has no folder after it", ["--draft", "--out"]],
  ]) {
    it(`should refuse to build when --out ${label}`, () => {
      const cwd = mkdtempSync(join(tmpdir(), "openai-zip-cwd-"));
      made.push(cwd);
      const result = spawnSync(process.execPath, [buildScript, ...args], { cwd, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--out needs a folder/);
      assert.deepEqual(readdirSync(cwd), []);
    });
  }
});
