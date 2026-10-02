import { Command } from "commander"
import { realpathSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  findConfigFile,
  loadConfig,
  resolveAuth,
  type AuthSource,
  type ResolvedAuth,
} from "../../config.js"
import type { KennenConfig } from "../../types.js"
import { verifyVaultAccess, ntnEnvFromBaseUrl } from "../../auth/oauth.js"
import { classifyTokenPrefix } from "../../auth/token-prefix.js"
import { createClient } from "../../notion/client.js"
import { createLimitedClient } from "../../notion/rate-limit.js"
import { verifyVaultDatabases, MissingVaultDatabasesError } from "../../notion/setup.js"
import {
  formatBackgroundFailureStatus,
  loadBackgroundFailureStatus,
} from "../../hooks/background-failure-status.js"
import { encodeClaudeProjectPath, resolveClaudeSettingsPath } from "./claude-paths.js"
import {
  classifyClaudeMcpLauncher,
  classifyCodexMcpLauncher,
  classifyCursorMcpLauncher,
  detectYarnPnp,
  type HookStatus,
} from "./install.js"

type ProblemKind = "config" | "auth" | "vault" | "host-config" | "hooks"
type HookPresence = "present" | "stale" | "missing"
type DoctorLauncherStatus = HookStatus | "custom"

interface DoctorProblem {
  kind: ProblemKind
  message: string
  nextAction: string | string[]
}

interface ConfigCheck {
  cwd: string
  envRootRaw?: string
  envRoot?: string
  envRootDirectoryExists?: boolean
  envRootConfigExists?: boolean
  discovered: { path: string; root: string } | null
  effective: {
    path: string
    root: string
    source: "KENNEN_CONFIG_ROOT" | "discovery"
  } | null
  config: KennenConfig | null
  problem: DoctorProblem | null
}

interface HostCheck {
  lines: string[]
  problems: DoctorProblem[]
}

interface JsonMcpCheck extends HostCheck {
  hasKennenEntry: boolean
}

interface HostConfigInspection {
  configRoot: string
  envSource: NodeJS.ProcessEnv
  authSource?: AuthSource
  yarnPnp: boolean
  notionBaseUrlLiteral?: string
}

interface HostConfigRoots {
  claude: string
  omp: string
  codex: string
  cursor: string
}

type JsonMcpLauncher =
  | { kind: "claude"; inspect: HostConfigInspection }
  | {
      kind: "cursor"
      inspect: HostConfigInspection
      useGlobalScope: boolean
      launchCwd: string
    }

export interface DoctorDeps {
  resolveAuth: typeof resolveAuth
  createClient: typeof createClient
  createLimitedClient: typeof createLimitedClient
  verifyVaultAccess: typeof verifyVaultAccess
  verifyVaultDatabases: typeof verifyVaultDatabases
  loadBackgroundFailureStatus: typeof loadBackgroundFailureStatus
}

export interface RunDoctorOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  emit?: boolean
  deps?: Partial<DoctorDeps>
}

export interface DoctorResult {
  exitCode: number
  lines: string[]
  problems: DoctorProblem[]
}

const CONFIG_FILENAME = ".kennen.yaml"
const DEFAULT_NOTION_BASE_URL = "https://api.notion.so"

const DEFAULT_DEPS: DoctorDeps = {
  resolveAuth,
  createClient,
  createLimitedClient,
  verifyVaultAccess,
  verifyVaultDatabases,
  loadBackgroundFailureStatus,
}

export const doctorCommand = new Command("doctor")
  .description("Run read-only setup diagnostics for config, auth, vault, MCP, and hooks")
  .action(async () => {
    try {
      const result = await runDoctor()
      if (result.exitCode !== 0) {
        process.exit(result.exitCode)
        return
      }
    } catch (err) {
      console.error("Doctor failed:", formatError(err))
      process.exit(1)
      return
    }
  })

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  const deps = { ...DEFAULT_DEPS, ...(options.deps ?? {}) }
  const homeDir = options.homeDir ?? homedir()
  const lines: string[] = []
  const problems: DoctorProblem[] = []

  const configCheck = await loadConfigCheck(cwd, env)
  const configRoot = configCheck.effective?.root ?? configCheck.discovered?.root
  const inspectionRoot = configRoot ?? cwd
  lines.push("Config")
  lines.push(...formatConfigLines(configCheck))
  if (configCheck.problem) problems.push(configCheck.problem)

  let auth: ResolvedAuth | null = null
  lines.push("")
  lines.push("Auth")
  if (!configCheck.config || !configCheck.effective) {
    lines.push("  Skipped: config did not load.")
  } else {
    const authResult = await runAuthCheck(
      configCheck.config,
      configCheck.effective.root,
      env,
      deps
    )
    auth = authResult.auth
    lines.push(...authResult.lines)
    if (authResult.problem) problems.push(authResult.problem)
  }

  lines.push("")
  lines.push("Vault")
  if (!configCheck.config || !configCheck.effective || !auth) {
    lines.push("  Skipped: config and auth must resolve first.")
  } else {
    const vaultResult = await runVaultCheck(configCheck.config, auth, deps)
    lines.push(...vaultResult.lines)
    if (vaultResult.problem) problems.push(vaultResult.problem)
  }

  lines.push("")
  lines.push("MCP host config")
  const hostConfigRoots = await resolveHostConfigRoots(cwd, inspectionRoot)
  const hostCheck = await inspectHostConfig(hostConfigRoots, homeDir, configRoot, {
    configRoot: configRoot ?? inspectionRoot,
    envSource: env,
    authSource: auth?.source,
    yarnPnp: await detectYarnPnp(cwd),
  })
  lines.push(...hostCheck.lines)
  problems.push(...hostCheck.problems)

  lines.push("")
  lines.push("Hooks")
  const hookCheck = await inspectHooks(hostConfigRoots, homeDir, configRoot, deps)
  lines.push(...hookCheck.lines)
  problems.push(...hookCheck.problems)

  lines.push("")
  lines.push("Next action:")
  lines.push(...formatNextAction(selectNextAction(problems)))

  if (options.emit !== false) {
    for (const line of lines) console.log(line)
  }

  return {
    exitCode: problems.length > 0 ? 1 : 0,
    lines,
    problems,
  }
}

async function loadConfigCheck(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<ConfigCheck> {
  const envRootRaw = env["KENNEN_CONFIG_ROOT"]
  const envRoot = envRootRaw?.trim() ? resolve(envRootRaw.trim()) : undefined
  const discovered = await findConfigFile(cwd)
  const base: Omit<ConfigCheck, "effective" | "config" | "problem"> = {
    cwd,
    ...(envRootRaw !== undefined ? { envRootRaw } : {}),
    ...(envRoot !== undefined ? { envRoot } : {}),
    discovered,
  }

  if (envRoot) {
    const envRootDirectoryExists = await directoryExists(envRoot)
    const envConfigPath = join(envRoot, CONFIG_FILENAME)
    const envRootConfigExists = await fileExists(envConfigPath)
    const nextBase = { ...base, envRootDirectoryExists, envRootConfigExists }

    if (!envRootDirectoryExists || !envRootConfigExists) {
      return {
        ...nextBase,
        effective: null,
        config: null,
        problem: {
          kind: "config",
          message:
            "KENNEN_CONFIG_ROOT does not point at a directory containing .kennen.yaml.",
          nextAction: ["unset KENNEN_CONFIG_ROOT", "kennen doctor"],
        },
      }
    }

    return loadConfigFromPath(nextBase, {
      path: envConfigPath,
      root: envRoot,
      source: "KENNEN_CONFIG_ROOT",
    })
  }

  if (!discovered) {
    return {
      ...base,
      effective: null,
      config: null,
      problem: {
        kind: "config",
        message: "No .kennen.yaml was found from the current directory.",
        nextAction: "kennen init",
      },
    }
  }

  return loadConfigFromPath(base, { ...discovered, source: "discovery" })
}

async function loadConfigFromPath(
  base: Omit<ConfigCheck, "effective" | "config" | "problem">,
  effective: ConfigCheck["effective"]
): Promise<ConfigCheck> {
  try {
    const config = await loadConfig(effective!.path)
    return { ...base, effective, config, problem: null }
  } catch (err) {
    return {
      ...base,
      effective,
      config: null,
      problem: {
        kind: "config",
        message: `Config failed to load: ${formatError(err)}`,
        nextAction: [`Fix ${effective!.path}`, "kennen doctor"],
      },
    }
  }
}

function formatConfigLines(check: ConfigCheck): string[] {
  const lines = [`  Current working directory: ${check.cwd}`]
  if (check.envRootRaw === undefined || check.envRootRaw.trim() === "") {
    lines.push("  KENNEN_CONFIG_ROOT: not set")
  } else {
    lines.push(`  KENNEN_CONFIG_ROOT: ${check.envRoot}`)
    lines.push(`    directory: ${check.envRootDirectoryExists ? "present" : "missing"}`)
    lines.push(`    .kennen.yaml: ${check.envRootConfigExists ? "present" : "missing"}`)
  }

  if (check.discovered) {
    lines.push(`  Normal discovery: ${check.discovered.path}`)
  } else {
    lines.push("  Normal discovery: no .kennen.yaml found from cwd")
  }

  if (check.effective) {
    lines.push(`  Effective config: ${check.effective.path} (${check.effective.source})`)
  } else {
    lines.push("  Effective config: none")
  }

  if (check.problem) {
    lines.push(`  Status: blocking - ${check.problem.message}`)
  } else {
    lines.push("  Status: ok")
  }
  return lines
}

async function runAuthCheck(
  config: KennenConfig,
  configRoot: string,
  env: NodeJS.ProcessEnv,
  deps: DoctorDeps
): Promise<{
  auth: ResolvedAuth | null
  lines: string[]
  problem: DoctorProblem | null
}> {
  try {
    const auth = await deps.resolveAuth(config, configRoot)
    const lines = [
      `  Source: ${formatAuthSource(auth)}`,
      `  Token prefix: ${formatTokenPrefix(auth.token)}`,
      `  Workspace selector: ${formatWorkspaceSelector(config, env)}`,
    ]
    if (auth.workspaceId) lines.push(`  Resolved workspace: ${auth.workspaceId}`)
    lines.push(`  Notion environment: ${formatNotionEnvironment(auth.baseUrl)}`)
    lines.push("  Status: ok")
    return { auth, lines, problem: null }
  } catch (err) {
    return {
      auth: null,
      lines: [`  Status: blocking - ${formatError(err)}`],
      problem: {
        kind: "auth",
        message: "No Notion auth source resolved.",
        nextAction: authMissingNextAction(env),
      },
    }
  }
}

function formatAuthSource(auth: ResolvedAuth): string {
  switch (auth.source) {
    case "env-notion-api-token":
      return "NOTION_API_TOKEN (env)"
    case "ntn-auth-json":
      return "ntn auth.json"
  }
}

function formatTokenPrefix(token: string): string {
  switch (classifyTokenPrefix(token)) {
    case "personal-prod":
      return "personal token (ntn_)"
    case "personal-dev":
      return "personal token (development_ntn_)"
    case "integration":
      return "integration token (secret_)"
    case "unknown":
      return "unknown"
  }
}

function formatWorkspaceSelector(config: KennenConfig, env: NodeJS.ProcessEnv): string {
  if (env["NOTION_WORKSPACE_ID"]) return `${env["NOTION_WORKSPACE_ID"]} (env)`
  if (config.auth?.workspaceId) return `${config.auth.workspaceId} (.kennen.yaml)`
  return "none"
}

function formatNotionEnvironment(baseUrl: string | undefined): string {
  const effective = baseUrl ?? DEFAULT_NOTION_BASE_URL
  const env = ntnEnvFromBaseUrl(effective)
  if (!baseUrl) return `prod (${DEFAULT_NOTION_BASE_URL}; default)`
  if (env) return `${env} (${effective})`
  return `custom (${effective})`
}

function authMissingNextAction(env: NodeJS.ProcessEnv): string {
  if (env["NOTION_API_TOKEN"]?.trim()) return "kennen auth --status"
  return "kennen auth --login"
}

async function runVaultCheck(
  config: KennenConfig,
  auth: ResolvedAuth,
  deps: DoctorDeps
): Promise<{ lines: string[]; problem: DoctorProblem | null }> {
  const client = deps.createLimitedClient(deps.createClient(auth.token, auth.baseUrl))
  const access = await deps.verifyVaultAccess(client, config.vault.pageId)
  if (access.kind !== "ok") {
    return formatVaultAccessFailure(access, auth)
  }

  const lines = [`  Vault page: accessible (${access.pageTitle ?? config.vault.pageId})`]
  try {
    await deps.verifyVaultDatabases(client, config.vault.pageId)
    lines.push("  Required databases: present")
    lines.push("  Status: ok")
    return { lines, problem: null }
  } catch (err) {
    if (err instanceof MissingVaultDatabasesError) {
      lines.push(`  Required databases: missing ${err.missing.join(", ")}`)
      lines.push(
        err.present.length > 0
          ? `  Present databases: ${err.present.join(", ")}`
          : "  Present databases: none"
      )
      return {
        lines,
        problem: {
          kind: "vault",
          message: err.message,
          nextAction: missingDatabaseNextAction(err),
        },
      }
    }
    lines.push(`  Required databases: check failed - ${formatError(err)}`)
    return {
      lines,
      problem: {
        kind: "vault",
        message: "Required database probe failed.",
        nextAction: "kennen status",
      },
    }
  }
}

function formatVaultAccessFailure(
  result: Exclude<Awaited<ReturnType<typeof verifyVaultAccess>>, { kind: "ok" }>,
  auth: ResolvedAuth
): { lines: string[]; problem: DoctorProblem } {
  if (result.kind === "unknown-error") {
    return {
      lines: [`  Vault page: check failed - ${formatError(result.error)}`],
      problem: {
        kind: "vault",
        message: "Vault preflight returned an unexpected error.",
        nextAction: "kennen auth --status",
      },
    }
  }

  const nextAction =
    result.kind === "rate-limited"
      ? "kennen doctor"
      : auth.source === "ntn-auth-json"
        ? "kennen auth --login"
        : ["Rotate or export NOTION_API_TOKEN for the vault workspace", "kennen doctor"]

  return {
    lines: [`  Vault page: ${result.kind} - ${result.message}`],
    problem: {
      kind: "vault",
      message: result.message,
      nextAction,
    },
  }
}

function missingDatabaseNextAction(err: MissingVaultDatabasesError): string {
  const missing = new Set(err.missing)
  if (missing.size === 1 && missing.has("Entities")) return "kennen vault ensure-entities"
  if (err.present.length === 0) return "kennen init"
  return "kennen status"
}

async function inspectHostConfig(
  roots: HostConfigRoots,
  homeDir: string,
  expectedConfigRoot: string | undefined,
  inspect: HostConfigInspection
): Promise<HostCheck> {
  const problems: DoctorProblem[] = []
  const lines: string[] = []
  const [ompYarnPnp, claudeYarnPnp, codexYarnPnp, cursorYarnPnp] = await Promise.all([
    detectYarnPnp(roots.omp),
    detectYarnPnp(roots.claude),
    detectYarnPnp(roots.codex),
    detectYarnPnp(roots.cursor),
  ])

  const ompMcp = await inspectJsonMcpFile(
    ".omp/mcp.json",
    join(roots.omp, ".omp", "mcp.json"),
    expectedConfigRoot,
    { launcher: { kind: "claude", inspect: { ...inspect, yarnPnp: ompYarnPnp } } }
  )
  lines.push(...ompMcp.lines)
  problems.push(...ompMcp.problems)

  const claudeMcp = await inspectJsonMcpFile(
    ".mcp.json",
    join(roots.claude, ".mcp.json"),
    expectedConfigRoot,
    { launcher: { kind: "claude", inspect: { ...inspect, yarnPnp: claudeYarnPnp } } }
  )
  lines.push(...claudeMcp.lines)
  problems.push(...claudeMcp.problems)

  const claudeSettings = await inspectClaudeSettingsMcp(
    claudeSettingsLabel(roots.claude),
    resolveClaudeSettingsPath(roots.claude, homeDir),
    expectedConfigRoot
  )
  lines.push(...claudeSettings.lines)
  problems.push(...claudeSettings.problems)

  const codexConfig = await inspectCodexConfig(
    ".codex/config.toml",
    join(roots.codex, ".codex", "config.toml"),
    expectedConfigRoot,
    { ...inspect, yarnPnp: codexYarnPnp }
  )
  lines.push(...codexConfig.lines)
  problems.push(...codexConfig.problems)

  const codexHooksPath = join(roots.codex, ".codex", "hooks.json")
  lines.push(
    (await fileExists(codexHooksPath))
      ? "  .codex/hooks.json: present (hook checks below)"
      : "  .codex/hooks.json: not present"
  )

  const projectCursor = await inspectJsonMcpFile(
    ".cursor/mcp.json",
    join(roots.cursor, ".cursor", "mcp.json"),
    expectedConfigRoot,
    {
      cursor: true,
      launcher: {
        kind: "cursor",
        inspect: { ...inspect, yarnPnp: cursorYarnPnp },
        useGlobalScope: false,
        launchCwd: roots.cursor,
      },
    }
  )
  lines.push(...projectCursor.lines)
  problems.push(...projectCursor.problems)

  const globalCursor = await inspectJsonMcpFile(
    "~/.cursor/mcp.json",
    join(homeDir, ".cursor", "mcp.json"),
    expectedConfigRoot,
    {
      cursor: true,
      shadowedBy: projectCursor.hasKennenEntry ? "project .cursor/mcp.json" : undefined,
      launcher: {
        kind: "cursor",
        inspect: { ...inspect, yarnPnp: cursorYarnPnp },
        useGlobalScope: true,
        launchCwd: roots.cursor,
      },
    }
  )
  lines.push(...globalCursor.lines)
  problems.push(...globalCursor.problems)

  return { lines, problems }
}

async function resolveHostConfigRoots(
  cwd: string,
  fallbackRoot: string
): Promise<HostConfigRoots> {
  const [claude, omp, codex, cursor] = await Promise.all([
    findNearestHostConfigRoot(cwd, [[".mcp.json"]], fallbackRoot),
    findNearestHostConfigRoot(cwd, [[".omp", "mcp.json"]], fallbackRoot),
    findNearestHostConfigRoot(
      cwd,
      [
        [".codex", "config.toml"],
        [".codex", "hooks.json"],
      ],
      fallbackRoot
    ),
    findNearestHostConfigRoot(cwd, [[".cursor", "mcp.json"]], fallbackRoot),
  ])
  return { claude, omp, codex, cursor }
}

async function findNearestHostConfigRoot(
  startDir: string,
  relativePaths: readonly (readonly string[])[],
  fallbackRoot: string
): Promise<string> {
  let dir = resolve(startDir)
  const fallback = resolve(fallbackRoot)

  while (true) {
    for (const relativePath of relativePaths) {
      if (await fileExists(join(dir, ...relativePath))) return dir
    }
    if (dir === fallback) return fallback
    const parent = dirname(dir)
    if (parent === dir) return fallback
    dir = parent
  }
}

async function inspectJsonMcpFile(
  label: string,
  path: string,
  expectedConfigRoot: string | undefined,
  opts: { cursor?: boolean; shadowedBy?: string; launcher?: JsonMcpLauncher } = {}
): Promise<JsonMcpCheck> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind === "missing")
    return { lines: [`  ${label}: not present`], problems: [], hasKennenEntry: false }
  if (parsed.kind === "invalid") {
    if (opts.shadowedBy) {
      return {
        lines: [
          `  ${label}: invalid JSON - ${parsed.error} (shadowed by ${opts.shadowedBy})`,
        ],
        problems: [],
        hasKennenEntry: false,
      }
    }
    return {
      ...hostConfigProblem(label, `invalid JSON - ${parsed.error}`),
      hasKennenEntry: false,
    }
  }

  const mcpServers = objectRecord(parsed.value)?.["mcpServers"]
  const kennenEntry = objectRecord(mcpServers)?.["kennen"]
  if (!kennenEntry) {
    return {
      lines: [`  ${label}: present, Kennen MCP entry missing`],
      problems: [],
      hasKennenEntry: false,
    }
  }

  const lines = opts.shadowedBy
    ? [`  ${label}: Kennen MCP entry present (shadowed by ${opts.shadowedBy})`]
    : [`  ${label}: Kennen MCP entry present`]
  if (opts.cursor)
    lines.push("    hooks: MCP-only (Cursor has no Kennen Stop/session hooks)")
  if (opts.shadowedBy) return { lines, problems: [], hasKennenEntry: true }

  const rootLine = describeKennenConfigRoot(objectRecord(kennenEntry), expectedConfigRoot)
  if (rootLine.problem) {
    lines.push(`    ${rootLine.line}`)
    return {
      lines,
      hasKennenEntry: true,
      problems: [
        {
          kind: "host-config",
          message: `${label} has a stale KENNEN_CONFIG_ROOT.`,
          nextAction: "kennen install",
        },
      ],
    }
  }
  if (rootLine.line) lines.push(`    ${rootLine.line}`)
  const launcher = objectRecord(kennenEntry)
  const launcherStatus =
    launcher && opts.launcher ? classifyJsonMcpLauncher(launcher, opts.launcher) : null
  if (launcherStatus) lines.push(`    launcher: ${launcherStatus}`)
  if (launcherStatus === "stale") {
    return {
      lines,
      problems: [
        {
          kind: "host-config",
          message: `${label} has a stale Kennen MCP launcher.`,
          nextAction: "kennen install",
        },
      ],
      hasKennenEntry: true,
    }
  }
  return { lines, problems: [], hasKennenEntry: true }
}

function classifyJsonMcpLauncher(
  kennenEntry: Record<string, unknown>,
  launcher: JsonMcpLauncher
): DoctorLauncherStatus {
  const entryConfigRoot = objectRecord(kennenEntry["env"])?.["KENNEN_CONFIG_ROOT"]
  const inspect =
    typeof entryConfigRoot === "string" && entryConfigRoot
      ? { ...launcher.inspect, configRoot: entryConfigRoot }
      : launcher.inspect
  const notionBaseUrlLiteral = extractJsonMcpNotionBaseUrlLiteral(kennenEntry)
  let status: HookStatus
  if (launcher.kind === "claude") {
    status = classifyClaudeMcpLauncher(kennenEntry, {
      ...launcherOptions(inspect),
      notionBaseUrlLiteral,
    })
  } else {
    status = classifyCursorMcpLauncher(kennenEntry, {
      ...launcherOptions(inspect),
      notionBaseUrlLiteral,
      useGlobalScope: launcher.useGlobalScope,
      launchCwd: launcher.launchCwd,
    })
  }
  return status === "stale" && isCustomMcpLauncher(kennenEntry) ? "custom" : status
}

function launcherOptions(inspect: HostConfigInspection): {
  configRoot: string
  yarnPnp: boolean
  envSource: NodeJS.ProcessEnv
  authSource?: AuthSource
  notionBaseUrlLiteral?: string
} {
  return {
    configRoot: inspect.configRoot,
    yarnPnp: inspect.yarnPnp,
    envSource: inspect.envSource,
    authSource: inspect.authSource,
    notionBaseUrlLiteral: inspect.notionBaseUrlLiteral,
  }
}

function extractJsonMcpNotionBaseUrlLiteral(
  kennenEntry: Record<string, unknown>
): string | undefined {
  const env = objectRecord(kennenEntry["env"])
  const value =
    typeof env?.["NOTION_BASE_URL"] === "string" ? env["NOTION_BASE_URL"] : null
  return canonicalNotionBaseUrlLiteral(value)
}

async function inspectClaudeSettingsMcp(
  label: string,
  path: string,
  expectedConfigRoot: string | undefined
): Promise<HostCheck> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind === "missing")
    return { lines: [`  ${label}: not present`], problems: [] }
  if (parsed.kind === "invalid") {
    return hostConfigProblem(label, `invalid JSON - ${parsed.error}`)
  }

  const mcpServers = objectRecord(parsed.value)?.["mcpServers"]
  const kennenEntry = objectRecord(mcpServers)?.["kennen"]
  if (!kennenEntry) {
    return { lines: [`  ${label}: present; no legacy Kennen MCP entry`], problems: [] }
  }

  const lines = [`  ${label}: legacy Kennen MCP entry present (will migrate)`]
  const rootLine = describeKennenConfigRoot(objectRecord(kennenEntry), expectedConfigRoot)
  if (rootLine.line) lines.push(`    ${rootLine.line}`)
  return {
    lines,
    problems: [
      {
        kind: "host-config",
        message: `${label} still carries a legacy Kennen MCP entry.`,
        nextAction: "kennen install",
      },
    ],
  }
}

async function inspectCodexConfig(
  label: string,
  path: string,
  expectedConfigRoot: string | undefined,
  inspect: HostConfigInspection
): Promise<HostCheck> {
  const text = await readTextIfPresent(path)
  if (text.kind === "missing") return { lines: [`  ${label}: not present`], problems: [] }
  const block = extractTomlTableGroup(text.value, "mcp_servers.kennen")
  if (!block) {
    return { lines: [`  ${label}: present, Kennen MCP entry missing`], problems: [] }
  }

  const lines = [`  ${label}: Kennen MCP entry present`]
  const configRoot = extractShellEnvAssignment(block, "KENNEN_CONFIG_ROOT")
  const rootLine = compareConfigRoot(configRoot, expectedConfigRoot)
  if (rootLine.problem) {
    lines.push(`    ${rootLine.line}`)
    return {
      lines,
      problems: [
        {
          kind: "host-config",
          message: ".codex/config.toml has a stale KENNEN_CONFIG_ROOT.",
          nextAction: "kennen install",
        },
      ],
    }
  }
  if (rootLine.line) lines.push(`    ${rootLine.line}`)
  const notionBaseUrlLiteral = canonicalNotionBaseUrlLiteral(
    extractShellEnvAssignment(block, "NOTION_BASE_URL")
  )
  const launcherStatus = classifyDoctorCodexMcpLauncher(block, {
    ...launcherOptions(inspect),
    notionBaseUrlLiteral,
  })
  lines.push(`    launcher: ${launcherStatus}`)
  if (launcherStatus === "stale") {
    return {
      lines,
      problems: [
        {
          kind: "host-config",
          message: ".codex/config.toml has a stale Kennen MCP launcher.",
          nextAction: "kennen install",
        },
      ],
    }
  }
  return { lines, problems: [] }
}

function classifyDoctorCodexMcpLauncher(
  block: string,
  options: Parameters<typeof classifyCodexMcpLauncher>[1]
): DoctorLauncherStatus {
  const status = classifyCodexMcpLauncher(block, options)
  return status === "stale" && isCustomTomlMcpLauncher(block) ? "custom" : status
}

function hostConfigProblem(label: string, detail: string): HostCheck {
  return {
    lines: [`  ${label}: ${detail}`],
    problems: [
      {
        kind: "host-config",
        message: `${label}: ${detail}`,
        nextAction: "kennen install",
      },
    ],
  }
}

function describeKennenConfigRoot(
  kennenEntry: Record<string, unknown> | null,
  expectedConfigRoot: string | undefined
): { line: string | null; problem: boolean } {
  const env = objectRecord(kennenEntry?.["env"])
  const root =
    typeof env?.["KENNEN_CONFIG_ROOT"] === "string" ? env["KENNEN_CONFIG_ROOT"] : null
  return compareConfigRoot(root, expectedConfigRoot)
}

function compareConfigRoot(
  actualRoot: string | null,
  expectedConfigRoot: string | undefined
): { line: string | null; problem: boolean } {
  if (!actualRoot)
    return { line: "KENNEN_CONFIG_ROOT: not carried by entry", problem: false }
  if (!expectedConfigRoot) {
    return {
      line: `KENNEN_CONFIG_ROOT: ${actualRoot} (no discovered root to compare)`,
      problem: false,
    }
  }
  const resolvedActual = resolve(expandHome(actualRoot))
  const resolvedExpected = resolve(expectedConfigRoot)
  const normalizedActual = normalizeConfigRoot(resolvedActual)
  const normalizedExpected = normalizeConfigRoot(resolvedExpected)
  if (normalizedActual === normalizedExpected) {
    return { line: `KENNEN_CONFIG_ROOT: matches ${resolvedExpected}`, problem: false }
  }
  return {
    line: `KENNEN_CONFIG_ROOT: ${resolvedActual} (expected ${resolvedExpected})`,
    problem: true,
  }
}

function normalizeConfigRoot(resolvedPath: string): string {
  try {
    return realpathSync.native(resolvedPath)
  } catch {
    return resolvedPath
  }
}

async function inspectHooks(
  roots: HostConfigRoots,
  homeDir: string,
  configRoot: string | undefined,
  deps: DoctorDeps
): Promise<HostCheck> {
  const problems: DoctorProblem[] = []
  const lines: string[] = []
  const claudeMcpHasKennen = await jsonMcpFileHasKennenEntry(
    join(roots.claude, ".mcp.json")
  )
  const claude = await inspectClaudeHooks(
    join(roots.claude, ".claude", "settings.json"),
    resolveClaudeSettingsPath(roots.claude, homeDir),
    claudeMcpHasKennen
  )
  lines.push(...claude.lines)
  problems.push(...claude.problems)
  const codex = await inspectCodexHooks(
    join(roots.codex, ".codex", "hooks.json"),
    join(roots.codex, ".codex", "config.toml")
  )
  lines.push(...codex.lines)
  problems.push(...codex.problems)

  if (!configRoot) {
    lines.push("  Background failures: skipped (no config root)")
    return { lines, problems }
  }

  const report = await deps.loadBackgroundFailureStatus(configRoot)
  const backgroundLines = formatBackgroundFailureStatus(report).map((line) => `  ${line}`)
  lines.push(...backgroundLines)
  if (report.failures.length > 0) {
    problems.push({
      kind: "hooks",
      message: "Recent background hook failures are present.",
      nextAction: "kennen status",
    })
  }
  return { lines, problems }
}

function claudeSettingsLabel(projectDir: string): string {
  return `~/.claude/projects/${encodeClaudeProjectPath(projectDir)}/settings.json`
}

interface ClaudeHookFileCheck {
  kind: "missing" | "invalid" | "ok"
  label: string
  error?: string
  wakeup?: HookPresence
  autosave?: HookPresence
  sessionEnd?: boolean
  hasKennenOwnedHook?: boolean
}

async function inspectClaudeHooks(
  projectPath: string,
  homePath: string,
  required: boolean
): Promise<HostCheck> {
  const checks = await Promise.all([
    inspectClaudeHookFile(".claude/settings.json", projectPath),
    inspectClaudeHookFile("Claude Code hooks", homePath),
  ])
  const [project, home] = checks

  const complete = checks.find(
    (check) =>
      check.kind === "ok" &&
      check.wakeup === "present" &&
      check.autosave === "present" &&
      !check.sessionEnd
  )
  const withKennen = checks.find(
    (check) => check.kind === "ok" && check.hasKennenOwnedHook
  )
  const ok =
    complete ??
    withKennen ??
    (home.kind === "ok" ? home : project.kind === "ok" ? project : null)
  const invalidChecks = checks.filter((check) => check.kind === "invalid")

  if (!ok) {
    if (invalidChecks.length > 0) {
      return {
        lines: invalidChecks.map(
          (check) => `  ${check.label}: invalid JSON - ${check.error}`
        ),
        problems: invalidChecks.map((check) => ({
          kind: "hooks",
          message: `${check.label}: invalid JSON - ${check.error}`,
          nextAction: "kennen install",
        })),
      }
    }
    return {
      lines: [
        required
          ? "  Claude Code hooks: not present (required by .mcp.json Kennen MCP entry)"
          : "  Claude Code hooks: not present",
      ],
      problems: required
        ? [
            {
              kind: "hooks",
              message:
                "Claude Code hooks are missing while Claude Code Kennen MCP is configured.",
              nextAction: "kennen install",
            },
          ]
        : [],
    }
  }

  const wakeup = ok.wakeup ?? "missing"
  const autosave = ok.autosave ?? "missing"
  const sessionEnd = ok.sessionEnd ?? false
  const hasKennenOwnedHook = ok.hasKennenOwnedHook ?? false
  const enforceHooks = required || hasKennenOwnedHook
  const lines = [
    `  Claude Code wakeup hook: ${wakeup}`,
    `  Claude Code autosave hook: ${autosave}`,
  ]
  const problems: DoctorProblem[] = invalidChecks.map((check) => {
    lines.push(`  ${check.label}: invalid JSON - ${check.error}`)
    return {
      kind: "hooks",
      message: `${check.label}: invalid JSON - ${check.error}`,
      nextAction: "kennen install",
    }
  })

  for (const check of checks) {
    if (check.kind !== "ok" || check === ok || !check.hasKennenOwnedHook) continue
    lines.push(
      `  ${check.label} wakeup hook: ${check.wakeup}`,
      `  ${check.label} autosave hook: ${check.autosave}`
    )
    if (check.sessionEnd) {
      lines.push(`  ${check.label} SessionEnd hook: legacy Kennen entry present`)
    }
  }

  const kennenChecks = checks.filter(
    (check): check is ClaudeHookFileCheck & { kind: "ok" } =>
      check.kind === "ok" && Boolean(check.hasKennenOwnedHook)
  )
  const hasCompleteHooks = checks.some(
    (check) =>
      check.kind === "ok" &&
      check.wakeup === "present" &&
      check.autosave === "present" &&
      !check.sessionEnd
  )
  if (!required && kennenChecks.length > 0) {
    problems.push({
      kind: "hooks",
      message:
        "Claude Code hooks are present while Claude Code Kennen MCP is not configured.",
      nextAction: "kennen install",
    })
  }
  if (required && !hasCompleteHooks) {
    problems.push({
      kind: "hooks",
      message: "Claude Code hook config is missing or has a stale Kennen hook.",
      nextAction: "kennen install",
    })
  }
  if (
    enforceHooks &&
    (!required || hasCompleteHooks) &&
    kennenChecks.some(
      (check) => check.wakeup !== "present" || check.autosave !== "present"
    )
  ) {
    problems.push({
      kind: "hooks",
      message: "Claude Code hook config is missing or has a stale Kennen hook.",
      nextAction: "kennen install",
    })
  }
  if (kennenChecks.some((check) => check.sessionEnd)) {
    if (sessionEnd)
      lines.push("  Claude Code SessionEnd hook: legacy Kennen entry present")
    problems.push({
      kind: "hooks",
      message: "Claude Code SessionEnd still carries a legacy Kennen hook.",
      nextAction: "kennen install",
    })
  }
  return { lines, problems }
}

async function inspectClaudeHookFile(
  label: string,
  path: string
): Promise<ClaudeHookFileCheck> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind === "missing") return { kind: "missing", label }
  if (parsed.kind === "invalid") return { kind: "invalid", label, error: parsed.error }

  const hooks = objectRecord(objectRecord(parsed.value)?.["hooks"])
  const wakeup = classifyClaudeHookCommand(hooks?.["UserPromptSubmit"], "wakeup")
  const autosave = classifyClaudeHookCommand(hooks?.["Stop"], "autosave")
  const sessionEnd = hasHookCommand(hooks?.["SessionEnd"], "session-end")
  return {
    kind: "ok",
    label,
    wakeup,
    autosave,
    sessionEnd,
    hasKennenOwnedHook: wakeup !== "missing" || autosave !== "missing" || sessionEnd,
  }
}

async function inspectCodexHooks(
  hooksPath: string,
  configPath: string
): Promise<HostCheck> {
  const feature = await inspectCodexHooksFeature(configPath)
  const parsed = await readJsonIfPresent(hooksPath)
  if (parsed.kind === "missing") {
    if (!feature.hasKennenConfig) {
      return { lines: ["  Codex hooks: not present"], problems: [] }
    }
    const lines = [
      `  Codex hooks feature: ${feature.status}`,
      "  Codex hooks: not present",
    ]
    const problems: DoctorProblem[] = [
      {
        kind: "hooks",
        message: "Codex hooks file is missing while Codex Kennen MCP is configured.",
        nextAction: "kennen install",
      },
    ]
    if (!feature.enabled) problems.push(codexHooksFeatureProblem(feature.status))
    return {
      lines,
      problems,
    }
  }

  const problems: DoctorProblem[] = []
  const lines = [`  Codex hooks feature: ${feature.status}`]
  if (parsed.kind === "invalid") {
    lines.push(`  Codex hooks: invalid JSON - ${parsed.error}`)
    problems.push({
      kind: "hooks",
      message: `Codex hooks: invalid JSON - ${parsed.error}`,
      nextAction: "kennen install",
    })
    return { lines, problems }
  }

  const hooks = objectRecord(objectRecord(parsed.value)?.["hooks"])
  const wakeup = hasHookCommand(hooks?.["UserPromptSubmit"], "wakeup")
  const autosave = hasHookCommand(hooks?.["Stop"], "autosave")
  const enforceHooks = feature.hasKennenConfig || wakeup || autosave
  lines.push(
    `  Codex wakeup hook: ${wakeup ? "present" : "missing"}`,
    `  Codex autosave hook: ${autosave ? "present" : "missing"}`
  )
  if (!feature.hasKennenConfig && (wakeup || autosave)) {
    problems.push({
      kind: "hooks",
      message: "Codex hooks are present while Codex Kennen MCP is not configured.",
      nextAction: "kennen install",
    })
  }
  if (!feature.enabled && enforceHooks) {
    problems.push(codexHooksFeatureProblem(feature.status))
  }
  if (enforceHooks && (!wakeup || !autosave)) {
    problems.push({
      kind: "hooks",
      message: "Codex hook config is missing a Kennen hook.",
      nextAction: "kennen install",
    })
  }
  return { lines, problems }
}

function codexHooksFeatureProblem(status: string): DoctorProblem {
  return {
    kind: "hooks",
    message: `Codex hooks feature is not enabled (${status}).`,
    nextAction: "kennen install",
  }
}

async function inspectCodexHooksFeature(
  path: string
): Promise<{ enabled: boolean; hasKennenConfig: boolean; status: string }> {
  const text = await readTextIfPresent(path)
  if (text.kind === "missing") {
    return {
      enabled: false,
      hasKennenConfig: false,
      status: "missing (.codex/config.toml not present)",
    }
  }

  const hasKennenConfig = extractTomlTableGroup(text.value, "mcp_servers.kennen") !== null
  const value = extractTomlKeyValue(text.value, "features", "hooks")
  if (value === undefined) {
    return { enabled: false, hasKennenConfig, status: "missing" }
  }
  if (value === "true") return { enabled: true, hasKennenConfig, status: "enabled" }
  return { enabled: false, hasKennenConfig, status: `not true (${value})` }
}

function hasHookCommand(
  value: unknown,
  eventName: "wakeup" | "autosave" | "session-end"
): boolean {
  if (!Array.isArray(value)) return false
  const legacyScript = `${eventName}.sh`
  return value.some((entry) => {
    const hooks = objectRecord(entry)?.["hooks"]
    if (!Array.isArray(hooks)) return false
    return hooks.some((hook) => {
      const command = objectRecord(hook)?.["command"]
      return typeof command === "string"
        ? shellDispatchesToKennen(command, ["hooks", eventName]) ||
            command.includes(`/${legacyScript}`)
        : false
    })
  })
}

function classifyClaudeHookCommand(
  value: unknown,
  eventName: "wakeup" | "autosave"
): HookPresence {
  if (!Array.isArray(value)) return "missing"
  const legacyScript = `${eventName}.sh`
  const currentCommands = new Set([
    `cd "$CLAUDE_PROJECT_DIR" && kennen hooks ${eventName}`,
    `cd "$CLAUDE_PROJECT_DIR" && yarn run -T kennen hooks ${eventName}`,
  ])
  const anchoredPrefix = `cd "$CLAUDE_PROJECT_DIR" && `
  const kennenBinDispatchPattern = new RegExp(
    `^(?:cd "\\$CLAUDE_PROJECT_DIR" && )?(?:yarn (?:run -T )?)?kennen hooks ${eventName}$`
  )
  let stale = false

  for (const entry of value) {
    const hooks = objectRecord(entry)?.["hooks"]
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      const command = objectRecord(hook)?.["command"]
      if (typeof command !== "string") continue
      if (currentCommands.has(command)) return "present"
      if (
        command.startsWith(anchoredPrefix) &&
        shellDispatchesToKennen(command.slice(anchoredPrefix.length), [
          "hooks",
          eventName,
        ])
      ) {
        return "present"
      }
      if (
        kennenBinDispatchPattern.test(command) ||
        command.endsWith(`/${legacyScript}`)
      ) {
        stale = true
      }
      if (shellDispatchesToKennen(command, ["hooks", eventName])) stale = true
    }
  }

  return stale ? "stale" : "missing"
}

function selectNextAction(problems: DoctorProblem[]): string | string[] {
  const order: ProblemKind[] = ["config", "auth", "vault", "host-config", "hooks"]
  for (const kind of order) {
    const problem = problems.find((candidate) => candidate.kind === kind)
    if (problem) return problem.nextAction
  }
  return "No action needed."
}

function formatNextAction(nextAction: string | string[]): string[] {
  if (Array.isArray(nextAction)) {
    return nextAction.map((action, index) => `  ${index + 1}. ${action}`)
  }
  return [`  ${nextAction}`]
}

async function readJsonIfPresent(
  path: string
): Promise<
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; value: unknown }
> {
  const text = await readTextIfPresent(path)
  if (text.kind === "missing") return text
  try {
    return { kind: "ok", value: JSON.parse(text.value) }
  } catch (err) {
    return { kind: "invalid", error: formatError(err) }
  }
}

async function jsonMcpFileHasKennenEntry(path: string): Promise<boolean> {
  const parsed = await readJsonIfPresent(path)
  if (parsed.kind !== "ok") return false
  const mcpServers = objectRecord(parsed.value)?.["mcpServers"]
  return objectRecord(mcpServers)?.["kennen"] !== undefined
}

async function readTextIfPresent(
  path: string
): Promise<{ kind: "missing" } | { kind: "ok"; value: string }> {
  try {
    return { kind: "ok", value: await readFile(path, "utf-8") }
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return { kind: "missing" }
    throw err
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function splitTomlLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n")
  if (normalized === "") return []
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n")
}

function extractTomlTableGroup(text: string, tablePrefix: string): string | null {
  const lines = splitTomlLines(text)
  const sections: Array<{ name: string; start: number; end: number }> = []
  const headingPattern = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/
  for (let i = 0; i < lines.length; i++) {
    const match = headingPattern.exec(lines[i])
    if (!match) continue
    if (sections.length > 0) sections[sections.length - 1]!.end = i
    sections.push({ name: match[1]!.trim(), start: i, end: lines.length })
  }
  const matches = sections.filter(
    (section) =>
      section.name === tablePrefix || section.name.startsWith(`${tablePrefix}.`)
  )
  if (matches.length === 0) return null
  return lines.slice(matches[0]!.start, matches[matches.length - 1]!.end).join("\n")
}

function extractTomlKeyValue(
  text: string,
  tableName: string,
  key: string
): string | undefined {
  const lines = splitTomlLines(text)
  const headingPattern = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/
  const keyPattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  let inTable = false

  for (const line of lines) {
    const heading = headingPattern.exec(line)
    if (heading) {
      inTable = heading[1]!.trim() === tableName
      continue
    }
    if (!inTable) continue
    const match = keyPattern.exec(line)
    if (match) return match[1]!.trim()
  }

  return undefined
}

function extractShellEnvAssignment(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const normalized = text.replace(/\\"/g, '"')
  const match = new RegExp(`\\b${escaped}=`).exec(normalized)
  if (!match) return null

  let index = match.index + match[0].length
  let value = ""
  while (index < normalized.length) {
    const char = normalized[index]
    if (!char || /\s/.test(char)) break

    if (char === "'" || char === '"') {
      const quote = char
      index += 1
      const start = index
      while (index < normalized.length && normalized[index] !== quote) {
        index += 1
      }
      value += normalized.slice(start, index)
      if (normalized[index] === quote) index += 1
      continue
    }

    const start = index
    while (
      index < normalized.length &&
      normalized[index] !== "'" &&
      normalized[index] !== '"' &&
      !/\s/.test(normalized[index]!)
    ) {
      index += 1
    }
    value += normalized.slice(start, index)
  }

  return value.length > 0 ? value : null
}

function canonicalNotionBaseUrlLiteral(value: string | null): string | undefined {
  if (!value) return undefined
  if (value.startsWith("${") && value.endsWith("}")) return undefined
  return ntnEnvFromBaseUrl(value) ? value : undefined
}

function isCustomMcpLauncher(kennenEntry: Record<string, unknown>): boolean {
  const command = stringValue(kennenEntry["command"])
  const args = stringArray(kennenEntry["args"])
  return command !== null && args !== null && dispatchesToKennen(command, args, ["mcp"])
}

function isCustomTomlMcpLauncher(block: string): boolean {
  const command = extractTomlStringValue(block, "command")
  const args = extractTomlStringArray(block, "args")
  return command !== null && args !== null && dispatchesToKennen(command, args, ["mcp"])
}

function dispatchesToKennen(
  command: string,
  args: readonly string[],
  kennenArgs: readonly string[]
): boolean {
  if (argvDispatchesToKennen(command, args, kennenArgs)) return true
  const shellCommand = extractShellCommand(command, args)
  return shellCommand !== null && shellDispatchesToKennen(shellCommand, kennenArgs)
}

function argvDispatchesToKennen(
  command: string,
  args: readonly string[],
  kennenArgs: readonly string[]
): boolean {
  if (isKennenToken(command)) return argsStartWith(args, kennenArgs)
  if (isYarnToken(command)) return yarnArgsDispatchToKennen(args, kennenArgs)
  if (isNtxToken(command)) return argsStartWith(args, ["kennen", ...kennenArgs])
  return false
}

function extractShellCommand(command: string, args: readonly string[]): string | null {
  const executable = command.split("/").at(-1)
  if (executable !== "bash" && executable !== "sh" && executable !== "zsh") {
    return null
  }
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-lc" || args[index] === "-c") return args[index + 1]!
  }
  return null
}

function shellDispatchesToKennen(
  command: string,
  kennenArgs: readonly string[]
): boolean {
  const kennenTail = kennenArgs.map(escapeRegExp).join("\\s+")
  const quotedValue = `(?:"[^"]*"|'[^']*'|\\S+)`
  const cdPrefix = `(?:cd\\s+${quotedValue}\\s+&&\\s+)?`
  const envPrefix = `(?:[A-Z_][A-Z0-9_]*=${quotedValue}\\s+)*`
  const executablePath = `(?:(?:\\.{1,2}|~)?/[^\\s;&|]+)`
  const kennenDispatch = `(?:kennen|${executablePath}/kennen)\\s+${kennenTail}`
  const yarnDispatch = `yarn\\s+(?:run\\s+-T\\s+)?kennen\\s+${kennenTail}`
  const ntxDispatch = `(?:\\./ntx|ntx)\\s+kennen\\s+${kennenTail}`
  const pattern = new RegExp(
    `^\\s*${cdPrefix}${envPrefix}(?:exec\\s+)?(?:${kennenDispatch}|${yarnDispatch}|${ntxDispatch})\\s*$`
  )
  return pattern.test(command)
}

function isKennenToken(value: string): boolean {
  const token = stripSurroundingQuotes(value)
  return token === "kennen" || token.endsWith("/kennen")
}

function isYarnToken(value: string): boolean {
  const token = stripSurroundingQuotes(value)
  return token === "yarn" || token.endsWith("/yarn")
}

function isNtxToken(value: string): boolean {
  const token = stripSurroundingQuotes(value)
  return token === "ntx" || token === "./ntx"
}

function yarnArgsDispatchToKennen(
  args: readonly string[],
  kennenArgs: readonly string[]
): boolean {
  if (args[0] === "run" && args[1] === "-T") {
    return args[2] === "kennen" && argsStartWith(args.slice(3), kennenArgs)
  }
  return args[0] === "kennen" && argsStartWith(args.slice(1), kennenArgs)
}

function argsStartWith(args: readonly string[], expected: readonly string[]): boolean {
  return expected.every((arg, index) => args[index] === arg)
}

function stripSurroundingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null
}

function extractTomlStringValue(text: string, key: string): string | null {
  const raw = extractTomlBareKeyValue(text, key)
  if (!raw) return null
  const parsed = parseTomlString(raw)
  return typeof parsed === "string" ? parsed : null
}

function extractTomlStringArray(text: string, key: string): string[] | null {
  const raw = extractTomlBareKeyValue(text, key)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return stringArray(parsed)
  } catch {
    return null
  }
}

function extractTomlBareKeyValue(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (const line of splitTomlLines(text)) {
    const match = pattern.exec(line)
    if (match) return match[1]!.trim()
  }
  return null
}

function parseTomlString(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    return null
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function expandHome(path: string): string {
  if (path === "~" || path === "${HOME}") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  if (path.startsWith("${HOME}/")) return join(homedir(), path.slice("${HOME}/".length))
  return path
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code
  )
}

function formatError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string") return err
  return String(err)
}
