# OM documentation

For setup and day-to-day use, start with the [project README](../README.md). These docs explain how OM works and why.

| Doc                                           | Covers                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| [Architecture](architecture.md)               | Components, request flow, where things live                                     |
| [API reference](api.md)                       | Every HTTP endpoint, request/response shapes, errors                            |
| [Data model](data-model.md)                   | SQLite tables and the on-disk folder layout                                     |
| [Git integration](git-integration.md)         | Cloning, branches, worktrees, fetching, security                                |
| [Comparison rules](comparison-rules.md)       | Statuses, folder roll-up, name clashes, symlinks, sort order, summary counts    |
| [Investigation model](investigation-model.md) | Snapshots, divergence attribution, upstream applicability: semantics and limits |
| [Frontend](frontend.md)                       | Routes, URL state, components, data fetching, theming                           |
| [Testing](testing.md)                         | Test-first workflow, test layout, fixtures, mocking                             |
| [Decisions](decisions.md)                     | Key technical decisions and their trade-offs                                    |

Coding agents should also read [CLAUDE.md](../CLAUDE.md).
