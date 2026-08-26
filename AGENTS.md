# Repository agent rules

Before ending work, always do all of the following successfully:

1. Run `bun run typecheck`
2. Run `bun run check`
3. Run `bun run build`
4. Fix any failures before stopping

Additional rules:

- Do not leave `.codex-temp/` files staged for commit unless the task explicitly requires them in the repository.
- Prefer minimal, utilitarian UI changes over decorative styling unless the task explicitly asks for visual design work.
- If runtime or deployment changes were made, verify the changed path directly instead of assuming it works.
