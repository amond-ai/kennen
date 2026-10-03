import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const guardPath = fileURLToPath(
  new URL("../tools/check-kennen-config.mjs", import.meta.url)
)

let scratchDirs: string[] = []

interface GuardModule {
  validateKennenConfig(raw: string, label?: string): string[]
  validateStagedKennenConfig(cwd?: string): string[]
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs = []
})

function scratchDir(name: string) {
  const dir = mkdtempSync(join(tmpdir(), name))
  scratchDirs.push(dir)
  return dir
}

function writeConfig(dir: string, raw: string) {
  const file = join(dir, ".kennen.yaml")
  writeFileSync(file, raw)
  return file
}

async function loadGuardModule(): Promise<GuardModule> {
  return (await import(pathToFileURL(guardPath).href)) as GuardModule
}

describe("repo invariants", () => {
  it("does not track a `.kennen.yaml` at the repo root", () => {
    // Codifies the gitignored steady state introduced with #557. The
    // pre-commit guard enforces this on new commits, but a tracked
    // file already in HEAD wouldn't trip the guard — this test pins
    // the HEAD-side invariant so a future `git add -f .kennen.yaml`
    // landing through a different path (rebase, cherry-pick, manual
    // sequencer) fails CI.
    //
    // Non-git environments (vendored tarball install, npm pack) get a
    // clearer skip-with-diagnostic rather than a cryptic `fatal: not a
    // git repository` failure.
    const repoRoot = fileURLToPath(new URL("..", import.meta.url))
    let tracked: string
    try {
      tracked = execFileSync("git", ["ls-files", "--", ".kennen.yaml"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cannot verify repo invariant — git invocation failed (likely running outside the repo's git working tree): ${message}`,
        { cause: error }
      )
    }
    expect(tracked).toBe("")
  })
})

describe("committed Kennen config guard", () => {
  it("rejects any non-empty committed .kennen.yaml content", async () => {
    const { validateKennenConfig } = await loadGuardModule()
    const errors = validateKennenConfig(`
vault:
  pageId: "<your-vault-page-id>"
projects: []
`)

    expect(errors.join("\n")).toContain("must not be committed")
  })

  it("rejects committed auth.token values", async () => {
    const { validateKennenConfig } = await loadGuardModule()
    const errors = validateKennenConfig(`
vault:
  pageId: "<your-vault-page-id>"
auth:
  token: "secret"
`)

    expect(errors.join("\n")).toContain("must not be committed")
  })

  it("rejects an empty staged .kennen.yaml", async () => {
    // Reviewer-flagged regression: pre-tightening, the guard returned
    // success on whitespace-only staged content, so `git add -f
    // .kennen.yaml` with an empty file would slip past the pre-commit
    // hook. The new policy keys off the git index entry, not the
    // content, so any staged .kennen.yaml is rejected.
    const { validateStagedKennenConfig } = await loadGuardModule()
    const repo = scratchDir("kennen-config-guard-empty-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeConfig(repo, "")
    execFileSync("git", ["add", "-f", ".kennen.yaml"], { cwd: repo })

    const errors = validateStagedKennenConfig(repo)
    expect(errors.join("\n")).toContain("must not be committed")
  })

  it("passes silently when .kennen.yaml is not tracked", async () => {
    const { validateStagedKennenConfig } = await loadGuardModule()
    const repo = scratchDir("kennen-config-guard-untracked-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    expect(validateStagedKennenConfig(repo)).toEqual([])
  })

  it("rejects staged .kennen.yaml content even when unstaged edits would also fail", async () => {
    const { validateStagedKennenConfig } = await loadGuardModule()
    const repo = scratchDir("kennen-config-guard-staged-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeConfig(
      repo,
      `
vault:
  pageId: "<your-vault-page-id>"
`
    )
    execFileSync("git", ["add", "-f", ".kennen.yaml"], { cwd: repo })

    writeConfig(
      repo,
      `
vault:
  pageId: "personal-vault-page-id"
auth:
  token: "secret"
`
    )

    const stagedFirst = validateStagedKennenConfig(repo)
    expect(stagedFirst.join("\n")).toContain("must not be committed")

    execFileSync("git", ["add", "-f", ".kennen.yaml"], { cwd: repo })
    const stagedSecond = validateStagedKennenConfig(repo)
    expect(stagedSecond.join("\n")).toContain("must not be committed")
  }, 30_000)
})
