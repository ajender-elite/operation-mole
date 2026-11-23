# OM documentation

For setup and day-to-day use, start with the [project README](../README.md). These docs explain how OM works and why.

| Doc                                           | Covers                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Architecture](architecture.md)               | Components, request flow, where things live                                                |
| [API reference](api.md)                       | Every HTTP endpoint, request/response shapes, errors                                       |
| [Data model](data-model.md)                   | SQLite tables and the on-disk folder layout                                                |
| [Git integration](git-integration.md)         | Cloning, branches, worktrees, fetching, security                                           |
| [Comparison rules](comparison-rules.md)       | Statuses, folder roll-up, name clashes, symlinks, sort order, summary counts               |
| [Investigation model](investigation-model.md) | Snapshots, divergence attribution on request, upstream applicability: semantics and limits |
| [Frontend](frontend.md)                       | Routes, session tabs, URL state, components, data fetching, theming                        |
| [Testing](testing.md)                         | Test-first workflow, test layout, fixtures, mocking                                        |
| [Decisions](decisions.md)                     | Key technical decisions and their trade-offs                                               |

## Where the workflow is described

Inside a session, OM keeps each working context in its own tab: the **Overview** (add a repository first, then compare), **Folder Compare** (what differs), **File Compare** (one file at the compared commits) and **Upstream** (commit applicability). What accounts for a difference is shown only when asked (**Explain difference**).

- Tabs, their URLs and how they keep state: [Frontend → Tabs](frontend.md#tabs)
- What Explain difference computes, and for which scope: [Investigation model](investigation-model.md)
- Why it works this way: [Decisions](decisions.md) 22 (git repositories only) and 23 (tabs, explanation on request)

Coding agents should also read [CLAUDE.md](../CLAUDE.md).
