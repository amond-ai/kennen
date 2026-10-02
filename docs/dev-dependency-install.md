# Installing Kennen as a Dev Dependency

`@amond-ai/kennen` is publicly available from npm without registry or token
setup.

Teams that want every engineer's checkout to share the same Kennen config can
pin `@amond-ai/kennen` as a devDependency and commit assistant config alongside
the rest of the repo. Yarn PnP is the fully path-portable shape: no absolute
paths land in committed MCP config, so the same files work on every engineer's
checkout.

## Wiring the Consumer Repo

1. **Add the devDependency.**

   ```bash
   yarn add -D @amond-ai/kennen        # or `npm install -D @amond-ai/kennen`
   ```

2. **Run `kennen install` once locally.** From inside the consumer repo:

   ```bash
   yarn run -T kennen install -y  # Yarn PnP consumers
   npx kennen install -y          # npm / Yarn 1 consumers
   ```

   Default `kennen install` is `--client all`. It writes the **bin-dispatch**
   config shape for every supported host:
   - `.mcp.json` for Claude Code with
     `{ "command": "yarn", "args": ["run", "-T", "kennen", "mcp"] }` for Yarn
     PnP, or `{ "command": "kennen", "args": ["mcp"] }` for npm / Yarn 1
     (auto-detected via `.pnp.cjs`).
   - `.omp/mcp.json` for OMP with the same MCP command / args shape. OMP's
     native project config takes precedence over root `.mcp.json` and exposes
     Kennen's MCP tools without Kennen lifecycle hooks.
   - `.codex/config.toml` with the Kennen MCP server and
     `features.hooks = true`, plus `.codex/hooks.json` entries for
     `UserPromptSubmit` and `Stop` using `yarn run -T kennen hooks <event>` (PnP)
     or `kennen hooks <event>` (npm).
   - Project-scoped `.cursor/mcp.json` with the same MCP command / args shape
     as Claude Code. Use `--cursor-global` only when you want per-machine
     Cursor config instead.
   - Per-user Claude Code hook settings under
     `~/.claude/projects/<encoded-project>/settings.json` with
     `"command": "cd \"$CLAUDE_PROJECT_DIR\" && yarn run -T kennen hooks <event>"`
     (PnP) or `"command": "cd \"$CLAUDE_PROJECT_DIR\" && kennen hooks <event>"`
     (npm).

   OMP is MCP-only: it receives no Claude/Codex lifecycle hooks. Restart OMP
   or run `/mcp reload` after installing or changing `.omp/mcp.json`.

3. **Teach the repo's agents to prefer Kennen.** Add a short "Memory and
   note-taking" section to the repo's `AGENTS.md` and `CLAUDE.md` so agents know
   when to call Kennen tools instead of writing local-only notes. See
   [Quick Start step 6](../README.md#6-teach-your-agents-to-use-kennen) for a
   pasteable starter.

4. **Commit the project-local diff.** Under the default `--client all` flow,
   commit the generated `.mcp.json`, `.omp/mcp.json`, `.codex/config.toml`,
   `.codex/hooks.json`, `.cursor/mcp.json`, and docs changes that landed in the
   repo.


   **Yarn PnP consumers**: the committed files work on any teammate's fresh
   checkout. `yarn install` resolves `@amond-ai/kennen` from npm without
   credentials, and host assistants resolve `kennen` through Yarn's PnPAPI. No
   absolute paths or `${HOME}` placeholders land in the project-local MCP
   config.

   **npm / Yarn 1 consumers**: the committed MCP config carries a static
   `KENNEN_CONFIG_ROOT=<checkout-path>` so hosts can launch `kennen mcp` from
   unpredictable directories. Review that static path before sharing across
   different checkout locations, or have teammates rerun `kennen install`
   after checkout.

   Per-user Claude hook settings are local to each engineer and not part of
   the project diff; teammates should run `kennen install` after checkout to
   write their own host hook config.

> **Don't have a global `kennen` install on the same machine.** A global
> `npm install -g @amond-ai/kennen` would shadow the project-local devDep on
> PATH for shells that don't put `node_modules/.bin` ahead of global bins. Stick
> to one source of truth per machine.

## Migrating From a `~/.kennen` Deployment

Legacy `~/.kennen` installs, where every engineer cloned Kennen to home and the
committed config used absolute paths, still upgrade in place. Default
`kennen install` rewrites legacy entries to bin-dispatch and prints
`MCP server: upgraded (legacy → bin-dispatch)` in the install summary.
