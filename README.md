# artifacts.space skills

Give your coding agent a place to keep its work. The `artifacts-space` skill teaches agents
when to save plans, decisions, research, reviews, and handoffs to
[artifacts.space](https://artifacts.space), how to update them instead of
starting over, and how to answer the comments people leave. You read, comment
on, and share everything in the web app.

## Install

```bash
npx skills add artifacts-space/skills
```

The [skills](https://skills.sh) CLI installs the skill for the agents it finds
on your machine: Claude Code, Cursor, Codex, OpenCode, GitHub Copilot, Gemini
CLI, Windsurf, and many more. Add `-g` to install it for every project.

## Plugin

The plugin in [`plugins/artifacts-space`](plugins/artifacts-space) gives you
both halves in one install: the `artifacts-space` skill and the connection to
the MCP server. You sign in with OAuth in your browser; the plugin holds no
token.

It is not in any app's directory yet. Once it is listed, you install it from:

| App | Where |
| --- | --- |
| ChatGPT and Codex | The plugin directory (in Codex, `/plugins`) |
| Claude, Claude Desktop, and Claude Code | Claude's directory (in Claude Code, `/plugin`) |
| Cursor | The Cursor Marketplace, under Customize |
| Gemini CLI | The extension gallery, or `gemini extensions install https://github.com/artifacts-space/skills` |

Until then, `npx skills add` above and the MCP server below give you the same
skill and tools.

Maintainers: `node scripts/check-skills.mjs` checks the plugin too. Before you
send it to a directory, run it with `--release`, and build the OpenAI upload
with `node scripts/build-openai-zip.mjs` (it writes to `dist/`). The upload's
`mcp.json` is the plugin's file unchanged, with no sign-in settings: a current
Codex build drops a server whose `mcp.json` carries fields outside the schema,
and it finds OAuth from the server on its own
([openai/codex#53658](https://github.com/openai/codex/issues/53658)).

## Connect the MCP server

The skills tell your agent what to do. The MCP server lets it do it.

On your own computer, connect with OAuth and approve in your browser. There is
no token to copy:

```bash
claude mcp add --transport http artifacts https://artifacts.space/api/mcp
```

Cursor and other clients that support OAuth need only the URL:

```json
{
  "mcpServers": {
    "artifacts": { "url": "https://artifacts.space/api/mcp" }
  }
}
```

In CI and headless runs, create an access token under **Connections** in the
app, store it as a secret such as `ARTIFACTS_SPACE_TOKEN`, and send it as a
bearer token:

```bash
claude mcp add --transport http artifacts https://artifacts.space/api/mcp \
  --header "Authorization: Bearer $ARTIFACTS_SPACE_TOKEN"
```

## Make it the default

Some agents have their own way to make pages and docs, such as the Artifact
tool in Claude Code. To have your agent save to artifacts.space every time,
add this line to its instructions:

```text
Use artifacts.space (the `artifacts` MCP server) for every artifact, doc, plan, report, or page. Do not use any built-in artifact or document tool unless I name it.
```

| Agent | Every project | One project |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` | `AGENTS.md` |
| Cursor | Cursor Settings, Rules, User Rules | `AGENTS.md`, or a `.cursor/rules/*.mdc` rule with `alwaysApply: true` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `AGENTS.md` |
| fx | `~/.fx/AGENTS.md` | `AGENTS.md` |
| Other agents | The instructions file its docs name | `AGENTS.md`, which most agents read |

To turn off Claude Code's own Artifact tool as well, add this to
`~/.claude/settings.json`. The built-in tool stays off until you remove the
rule.

```json
{
  "permissions": {
    "deny": ["Artifact"]
  }
}
```

`npx skills add` only copies the skill. It changes none of these files, so
add the line yourself.

## Skills

| Skill | What it does |
| --- | --- |
| [`artifacts-space`](skills/artifacts-space/SKILL.md) | Connects the MCP server, saves and updates artifacts, picks formats, reads and replies to comments, and keeps secrets and sharing safe. |
| [`import-artifacts`](skills/import-artifacts/SKILL.md) | Brings your old work into artifacts.space: Claude artifacts, ChatGPT canvases, and the plans and docs your coding agents wrote, from one account or several. You pick what to import, secrets are caught first, duplicates are skipped, and everything stays private. |

## License

MIT
