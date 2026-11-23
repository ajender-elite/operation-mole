# AGENTS.md

Instructions for AI coding agents live in [CLAUDE.md](CLAUDE.md). It covers commands, project layout, conventions, domain rules and known pitfalls. Design and reference docs are in [docs/](docs/README.md).

Short version:

- Write the test first, watch it fail, then implement.
- Finish with `pnpm check` passing.
- Don't weaken the git URL and environment restrictions in `apps/server/src/git/git-service.ts`.
