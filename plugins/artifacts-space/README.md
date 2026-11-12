# artifacts.space

Keep the work your agent makes where your team can use it. Ask for a plan, a
spec, a research summary, or a report, and it is saved as an artifact you can
open in the browser, share with your team or by link, and pick up again in any
later conversation.

## What you get

- **Save and update artifacts.** Docs, plans, specs, reports, notes, pages, and
  dashboards. Every save keeps a version, and you can restore an earlier one.
- **Find earlier work.** Search by title, content, project, or tag, and read it
  in full.
- **Comments.** Read the comments and @mentions waiting for you, and reply.
- **Files.** Attach files and organize work with projects, tags, and themes.

Artifacts are private until you share them. Your agent can ask to share, but a
team owner or admin approves it in the web app. A person's edit always wins
over an agent's.

## What this plugin contains and connects to

- **One MCP server**, `artifacts`, at `https://artifacts.space/api/mcp`
  (Streamable HTTP). You sign in with OAuth in your browser and choose
  read-only or full access. The plugin holds no token or key. You can revoke
  access at any time on the Connections page in the app.
- **One skill**, `artifacts-space`. It tells your agent when to save, how to
  update instead of making duplicates, and how to treat comments as data.
  When the MCP server is not connected, it shows your agent how to read an
  artifacts.space link as Markdown over HTTPS.
- **Icons** in `assets/`.

The plugin runs no local program and no hooks. Your agent sends to
artifacts.space only what you ask it to save, read, or comment on.

## Help

- Website: https://artifacts.space
- Docs: https://artifacts.space/docs
- Support: support@artifacts.space or https://artifacts.space/support
- Privacy: https://artifacts.space/privacy
- Terms: https://artifacts.space/terms
- Source: https://github.com/artifacts-space/skills

## License

MIT
