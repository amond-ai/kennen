import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const versionSyncPath = fileURLToPath(
  new URL("../tools/check-version-sync.mjs", import.meta.url)
)

const PATHS = {
  packageJson: "package.json",
  mcpServer: "src/mcp/server.ts",
  cliIndex: "src/cli/index.ts",
  notionClient: "src/notion/client.ts",
}

let scratchDirs: string[] = []

interface VersionSyncModule {
  validateVersionSources(contents: Record<string, string>): string[]
  validateVersionSync(options?: { cwd?: string; staged?: boolean }): string[]
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs = []
})

async function loadVersionSyncModule(): Promise<VersionSyncModule> {
  return (await import(pathToFileURL(versionSyncPath).href)) as VersionSyncModule
}

function scratchDir(name: string) {
  const dir = mkdtempSync(join(tmpdir(), name))
  scratchDirs.push(dir)
  return dir
}

function versionFiles(version: string): Record<string, string> {
  return {
    [PATHS.packageJson]: JSON.stringify({ version }, null, 2),
    [PATHS.mcpServer]: `new McpServer({ name: "kennen", version: "${version}" }, {})`,
    [PATHS.cliIndex]: `program.name("kennen").version("${version}")`,
    [PATHS.notionClient]: `const USER_AGENT = "kennen/${version}"`,
  }
}

function writeVersionFiles(dir: string, version: string) {
  for (const [path, contents] of Object.entries(versionFiles(version))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
}

function git(repo: string, args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
}

describe("version sync guard", () => {
  it("accepts the current repo version literals", async () => {
    const { validateVersionSync } = await loadVersionSyncModule()

    expect(validateVersionSync({ cwd: repoRoot })).toEqual([])
  })

  it("rejects divergent version literals", async () => {
    const { validateVersionSources } = await loadVersionSyncModule()
    const files = versionFiles("0.14.0")
    files[PATHS.cliIndex] = 'program.name("kennen").version("0.15.0")'

    const errors = validateVersionSources(files)

    expect(errors.join("\n")).toContain("src/cli/index.ts Commander version")
    expect(errors.join("\n")).toContain("expected 0.14.0 from package.json#version")
  })

  it("reports missing version literals", async () => {
    const { validateVersionSources } = await loadVersionSyncModule()
    const files = versionFiles("0.14.0")
    files[PATHS.notionClient] = 'const USER_AGENT = "custom-client"'

    const errors = validateVersionSources(files)

    expect(errors.join("\n")).toContain('USER_AGENT = "kennen/..."')
  })

  it("validates the staged index for pre-commit checks", async () => {
    const { validateVersionSync } = await loadVersionSyncModule()
    const repo = scratchDir("kennen-version-sync-staged-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeVersionFiles(repo, "1.2.3")
    git(repo, [
      "add",
      "package.json",
      "src/mcp/server.ts",
      "src/cli/index.ts",
      "src/notion/client.ts",
    ])

    writeFileSync(join(repo, PATHS.cliIndex), 'program.name("kennen").version("9.9.9")')
    expect(validateVersionSync({ cwd: repo, staged: true })).toEqual([])

    git(repo, ["add", PATHS.cliIndex])
    const errors = validateVersionSync({ cwd: repo, staged: true })
    expect(errors.join("\n")).toContain("9.9.9")
  })
})
