import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { buildClaudeMcpEntry, buildLegacyClaudeMcpEntry } from "./claude.js"
import type { BinDispatchShape, HookStatus, InstallContext } from "./types.js"
import {
  confirm,
  deepEqual,
  displayHomePath,
  isEffectivelyCurrent,
  postWriteLabel,
  readJsonSafe,
  statusLabel,
  toPortablePath,
  writeJsonFile,
} from "./utils.js"

export const OMP_MCP_SCHEMA_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json"

export function resolveOmpMcpPath(projectDir: string): string {
  return join(projectDir, ".omp", "mcp.json")
}

export async function runOmpInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
  ompMcpPath: string
): Promise<void> {
  const ompMcpJson = await readJsonSafe(ompMcpPath)
  const mcpServers = (ompMcpJson.mcpServers ?? {}) as Record<string, unknown>
  const existingMcp = mcpServers["kennen"] as Record<string, unknown> | undefined

  const binShape: BinDispatchShape = context.yarnPnp ? "yarn" : "bare"
  const binMcpEntry = buildClaudeMcpEntry(
    binShape,
    context.configRoot,
    process.env,
    context.authSource,
    context.notionBaseUrlLiteral
  )
  const legacyMcpEntry = buildLegacyClaudeMcpEntry(
    toPortablePath(context.mcpJsPath),
    toPortablePath(context.pkgRoot),
    context.configRoot,
    process.env,
    context.authSource,
    context.notionBaseUrlLiteral
  )
  const desiredMcpEntry = context.legacyPaths ? legacyMcpEntry : binMcpEntry
  const mcpStatus: HookStatus = !existingMcp
    ? "missing"
    : deepEqual(existingMcp, binMcpEntry)
      ? "current"
      : deepEqual(existingMcp, legacyMcpEntry)
        ? "legacy-current"
        : "stale"

  const ompMcpDisplay = displayHomePath(ompMcpPath)
  console.log("OMP:")
  console.log(
    `  MCP server:        ${statusLabel(mcpStatus, context.legacyPaths)} (${ompMcpDisplay})`
  )

  if (isEffectivelyCurrent(mcpStatus, context.legacyPaths)) {
    console.log("  Everything is already installed.")
    return
  }

  console.log()
  const proceed = await confirm(rl, "Install Kennen OMP integration for this project?")
  if (!proceed) {
    console.log("  Skipped.")
    return
  }

  const merged: Record<string, unknown> = { ...ompMcpJson }
  if (!Object.prototype.hasOwnProperty.call(merged, "$schema")) {
    merged["$schema"] = OMP_MCP_SCHEMA_URL
  }
  merged.mcpServers = {
    ...((ompMcpJson.mcpServers as Record<string, unknown>) ?? {}),
    kennen: desiredMcpEntry,
  }

  console.log()
  console.log(`  Writing: ${ompMcpDisplay}`)
  await writeJsonFile(ompMcpPath, merged)

  console.log()
  console.log(
    `  MCP server:        ${postWriteLabel(mcpStatus, context.legacyPaths)} (${ompMcpDisplay})`
  )
  console.log(
    "  This integration exposes Kennen's MCP tools but installs no Kennen lifecycle hooks."
  )
  console.log("  Restart OMP or run `/mcp reload` for changes to take effect.")
}
