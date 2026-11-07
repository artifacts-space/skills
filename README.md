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

## Skills

| Skill | What it does |
| --- | --- |
| [`artifacts-space`](skills/artifacts-space/SKILL.md) | Connects the MCP server, saves and updates artifacts, picks formats, reads and replies to comments, and keeps secrets and sharing safe. |

## License

MIT
