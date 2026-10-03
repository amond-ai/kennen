import { spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const PLUGIN_ROOT = resolve("plugins/kennen")
const LAUNCHER = join(PLUGIN_ROOT, "libexec/kennen.sh")

type HookGroup = { hooks: Array<{ type: string; command: string }> }

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T
}

describe("Claude Code plugin manifests", () => {
  it("lists the kennen plugin from the repo marketplace", async () => {
    const marketplace = await readJson<{
      plugins: Array<{ name: string; source: string }>
    }>(".claude-plugin/marketplace.json")
    const entry = marketplace.plugins.find((plugin) => plugin.name === "kennen")
    expect(entry).toBeDefined()

    const manifest = await readJson<{ name: string }>(
      join(entry!.source, ".claude-plugin/plugin.json")
    )
    expect(manifest.name).toBe("kennen")
  })

  it("dispatches the same hook events kennen install registers for Claude", async () => {
    const { hooks } = await readJson<{ hooks: Record<string, HookGroup[]> }>(
      join(PLUGIN_ROOT, "hooks/hooks.json")
    )
    const commandsFor = (event: string) =>
      (hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))

    expect(commandsFor("UserPromptSubmit")).toEqual([
      expect.stringMatching(
        /libexec\/kennen\.sh" "\$\{CLAUDE_PROJECT_DIR\}" hooks wakeup$/
      ),
    ])
    expect(commandsFor("Stop")).toEqual([
      expect.stringMatching(
        /libexec\/kennen\.sh" "\$\{CLAUDE_PROJECT_DIR\}" hooks autosave$/
      ),
    ])
  })
})

describe.skipIf(process.platform === "win32")("Claude Code plugin launcher", () => {
  let workDir: string
  let binDir: string
  let projectDir: string

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "kennen-plugin-")))
    binDir = join(workDir, "bin")
    projectDir = join(workDir, "project")
    await mkdir(binDir)
    await mkdir(join(projectDir, "packages/app"), { recursive: true })
    const fakeKennen = join(binDir, "kennen")
    await writeFile(fakeKennen, '#!/bin/sh\necho "cwd=$(pwd) args=$*"\n')
    await chmod(fakeKennen, 0o755)
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  function runLauncher(cwd: string, ...args: string[]) {
    return spawnSync("sh", [LAUNCHER, cwd, ...args], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
      input: "{}",
    })
  }

  it("skips hook events when no .kennen.yaml is found above the project", () => {
    const result = runLauncher(join(projectDir, "packages/app"), "hooks", "autosave")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
  })

  it("runs hook events from the project directory when a vault config is found upward", async () => {
    await writeFile(join(projectDir, ".kennen.yaml"), "")
    const appDir = join(projectDir, "packages/app")

    const result = runLauncher(appDir, "hooks", "wakeup")

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(`cwd=${appDir} args=hooks wakeup`)
  })

  it("dispatches through yarn run -T in a Yarn PnP workspace", async () => {
    await writeFile(join(projectDir, ".kennen.yaml"), "")
    await writeFile(join(projectDir, ".pnp.cjs"), "")
    await rm(join(binDir, "kennen"))
    const fakeYarn = join(binDir, "yarn")
    await writeFile(fakeYarn, '#!/bin/sh\necho "yarn cwd=$(pwd) args=$*"\n')
    await chmod(fakeYarn, 0o755)
    const appDir = join(projectDir, "packages/app")

    const result = runLauncher(appDir, "hooks", "wakeup")

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(
      `yarn cwd=${appDir} args=run -T kennen hooks wakeup`
    )
  })
})
