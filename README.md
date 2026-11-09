# artifacts.space skills

Give your coding agent a place to keep its work. This skill teaches agents
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

## Connect the MCP server

The skill tells your agent what to do. The MCP server lets it do it.

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
Use artifacts.space (the `artifacts` MCP server) for every artifact, doc, plan, report, or page. Do not use a built-in artifact tool unless I name it.
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

## License

MIT
