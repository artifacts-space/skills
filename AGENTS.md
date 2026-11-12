# Contributor guide

This repository holds the public agent skills for artifacts.space, installed
with `npx skills add artifacts-space/skills`. `CLAUDE.md` is a symlink to this
file; edit `AGENTS.md`, never replace the symlink.

- Each skill lives at `skills/<name>/SKILL.md`, with `name` and `description`
  in its YAML frontmatter. `name` matches the folder. Keep no `SKILL.md` at the
  repository root, or skills.sh stops looking in `skills/`.
- The `description` decides when an agent loads the skill. Write it as a
  precise trigger: when to save, read, or update artifacts.
- Keep skills thin. Name only tools that exist in the app's
  `src/lib/mcp/tool-access.ts`, and defer format details to the
  `artifacts_formats_guide` MCP tool instead of restating the catalog.
- Never put real tokens or secrets in examples. Use `YOUR_TOKEN` or
  `$ARTIFACTS_SPACE_TOKEN`.
- Run `node scripts/check-skills.mjs` before you commit. CI runs it too.
- A skill may ship a small helper under `skills/<name>/scripts/`: Node or
  Python standard library only, no network, read-only on the user's data.
  Test it in `tests/` with synthetic fixtures, never real user data, and run
  `node --test "tests/**/*.test.mjs"`. CI runs the tests too.
- `plugins/artifacts-space/` is the plugin for the OpenAI, Claude, and Cursor
  directories; `gemini-extension.json` is the Gemini CLI extension. The
  plugin's `skills/artifacts-space/` must be an exact copy of
  `skills/artifacts-space/` (no symlinks; the directories reject them), so
  after you change the skill run
  `cp -R skills/artifacts-space plugins/artifacts-space/skills/`. Raise
  `version` in every manifest together. `node scripts/check-skills.mjs`
  checks all of this; add `--release` before a directory submission.
- `node scripts/build-openai-zip.mjs` builds the OpenAI upload. It leaves out
  the Claude files and ships `mcp.json` unchanged. Add no sign-in settings or
  other fields outside the Agent Plugins schema: a current Codex build drops
  such a server, and it finds OAuth from the server on its own
  (openai/codex#53658).
- Commit messages are conventional: `feat:`, `fix:`, `docs:`, `chore:`.
