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
- Commit messages are conventional: `feat:`, `fix:`, `docs:`, `chore:`.
