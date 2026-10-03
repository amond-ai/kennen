# AGENTS.md -- src/cli/

> Read the root `AGENTS.md` first. This file routes CLI work. For detailed
> implementation contracts, read the linked docs below before editing command
> code.

## Purpose

This directory implements Kennen's command-line interface using commander.js.
The CLI is the secondary interface for direct human interaction: setup,
debugging, manual search, vault maintenance, and operator workflows.

## Required Reading

| Work area                                   | Read                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adding or changing command code             | [`../../docs/cli-authoring.md`](../../docs/cli-authoring.md)                                                                                                                               |
| Command-specific implementation contracts   | [`../../docs/cli-command-contracts.md`](../../docs/cli-command-contracts.md) and the per-command files linked from that index                                                              |
| User-facing workflows and command reference | [`../../docs/cli.md`](../../docs/cli.md)                                                                                                                                                   |
| Auth behavior used by `auth` / `install`    | [`../../docs/authentication.md`](../../docs/authentication.md), [`../auth/AGENTS.md`](../auth/AGENTS.md)                                                                                   |
| Profiles                                    | [`../../docs/profiles.md`](../../docs/profiles.md)                                                                                                                                         |
| Memory debt                                 | [`../../docs/memory-debt.md`](../../docs/memory-debt.md)                                                                                                                                   |
| Conflict scans                              | [`../../docs/conflict-detection.md`](../../docs/conflict-detection.md)                                                                                                                     |
| Eval harness                                | [`../../docs/evals.md`](../../docs/evals.md), [`../../docs/evals-suite-format.md`](../../docs/evals-suite-format.md), [`../../docs/evals-longmemeval.md`](../../docs/evals-longmemeval.md) |

## Command Inventory

This inventory is routing guidance for the public CLI surface, not a
single-file ownership map. Keep it when commands are added or removed; put
file-local edit triggers in the owning file's `ABOUTME` comment or module
JSDoc when the filename is not enough.

The registered commands in [`index.ts`](index.ts) and the user-facing overview
in [`../../docs/cli.md`](../../docs/cli.md) must stay in sync.

| File                                               | Command surface                                                 |
| -------------------------------------------------- | --------------------------------------------------------------- |
| [`commands/init.ts`](commands/init.ts)             | `kennen init [page-id]`                                         |
| [`commands/auth.ts`](commands/auth.ts)             | `kennen auth`                                                   |
| [`commands/doctor.ts`](commands/doctor.ts)         | `kennen doctor`                                                 |
| [`commands/search.ts`](commands/search.ts)         | `kennen search <query>`                                         |
| [`commands/memory.ts`](commands/memory.ts)         | `kennen memory save`                                            |
| [`commands/decision.ts`](commands/decision.ts)     | `kennen decision create`                                        |
| [`commands/ask.ts`](commands/ask.ts)               | `kennen ask <entity>`                                           |
| [`commands/mine.ts`](commands/mine.ts)             | `kennen mine [path]`                                            |
| [`commands/inbox.ts`](commands/inbox.ts)           | `kennen inbox list/approve/reject/archive`                      |
| [`commands/pinned.ts`](commands/pinned.ts)         | `kennen pinned list`                                            |
| [`commands/status.ts`](commands/status.ts)         | `kennen status`                                                 |
| [`commands/costs.ts`](commands/costs.ts)           | `kennen costs summary/export`                                   |
| [`commands/install.ts`](commands/install.ts)       | `kennen install`                                                |
| [`commands/migrate.ts`](commands/migrate.ts)       | `kennen migrate`                                                |
| [`commands/digest.ts`](commands/digest.ts)         | `kennen digest`                                                 |
| [`commands/tasks.ts`](commands/tasks.ts)           | `kennen tasks create/update/close/close-many/list/reconcile`    |
| [`commands/conflicts.ts`](commands/conflicts.ts)   | `kennen conflicts scan`                                         |
| [`commands/debt.ts`](commands/debt.ts)             | `kennen debt scan/create-tasks`                                 |
| [`commands/procedures.ts`](commands/procedures.ts) | `kennen procedures scan/propose/deprecate`                      |
| [`commands/entities.ts`](commands/entities.ts)     | `kennen entities merge`                                         |
| [`commands/vault.ts`](commands/vault.ts)           | `kennen vault ensure-entities/migrate-agent-diary`              |
| [`commands/eval.ts`](commands/eval.ts)             | `kennen eval run/baseline/vaults/bench`                         |
| [`commands/promote.ts`](commands/promote.ts)       | `kennen promote <memoryId> --to <name>`                         |
| [`commands/mcp.ts`](commands/mcp.ts)               | `kennen mcp`                                                    |
| [`commands/hooks.ts`](commands/hooks.ts)           | `kennen hooks wakeup/autosave/session-end`                      |
| [`commands/profile.ts`](commands/profile.ts)       | `kennen profile list/show/validate/preview/install/set/migrate` |

## Layer Rules

- Commands that interact with the vault call `initServices()` from
  [`../services.ts`](../services.ts), except `init`, `install`, and the auth
  status/login paths that intentionally construct narrower dependencies.
- CLI and hooks import from [`../services.ts`](../services.ts), not from
  [`../mcp/server.ts`](../mcp/server.ts).
- Keep internal relative imports ESM-shaped with `.js` extensions.
- Keep `commands/migrate.ts` as the `kennen migrate` Commander router; focused
  migration implementations and CLI-only renderers live under
  `commands/migrate/`.
- Parse raw CLI flags before service initialization when a parse failure should
  exit without touching Notion.
- Treat explicit scope misses as fatal. A miss for `--project <name>` exits
  non-zero instead of falling back to auto-detected or vault-wide scope.
- Normal output goes to `console.log`; errors go to `console.error`; warnings
  go to `console.warn` only when the requested operation can still proceed.
- Preserve JSON pipe cleanliness: progress and diagnostics go to stderr when a
  command supports `--json`.

## Change Checklist

When adding or changing a CLI command:

1. Follow the commander, service initialization, error handling, output, and
   exit-path test conventions in
   [`../../docs/cli-authoring.md`](../../docs/cli-authoring.md).
2. Update or add the relevant per-command contract linked from
   [`../../docs/cli-command-contracts.md`](../../docs/cli-command-contracts.md).
3. Update [`../../docs/cli.md`](../../docs/cli.md) when the user-facing command
   surface, flags, output shape, or workflow changes.
4. Add or update focused tests under [`commands/`](commands/) when behavior
   changes.
5. Run `bun run typecheck` before committing.

Do not change CLI behavior as part of documentation-only splits. If a
documentation edit discovers runtime drift, fix it in a focused code change or
call it out before widening the patch.
