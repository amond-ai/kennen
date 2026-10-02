import type { KennenServices } from "../../server.js"
import { fireTouchOnRead, toolError } from "../../helpers.js"
import { debugLogPartialFailures } from "../../../observability/partial-failure.js"
import { settleAll } from "../../../core/settle.js"
import { isMemoryResultHandle } from "../../../memory-result-handles.js"
import type { Memory } from "../../../types.js"
import type { ToolResult } from "./types.js"

type ExpandTarget =
  | { ok: true; input: string; id: string }
  | { ok: false; input: string; message: string }

export async function handleExpand(
  services: KennenServices,
  args: { ids: string[] }
): Promise<ToolResult> {
  try {
    const targets: ExpandTarget[] = []
    const seen = new Set<string>()
    for (const input of args.ids) {
      const target = resolveExpandTarget(services, input)
      const dedupeKey = target.ok ? `id:${target.id}` : `unresolved:${target.input}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      targets.push(target)
    }

    const idsToFetch = targets
      .filter((target): target is Extract<ExpandTarget, { ok: true }> => target.ok)
      .map((target) => target.id)

    const { fulfilled, failures } = await settleAll(
      idsToFetch.map((id) => [id, services.memories.getById(id)] as const)
    )
    if (failures.length > 0) {
      debugLogPartialFailures(
        "kennen-memory",
        failures.map(({ key, error }) => ({ rootId: key, error }))
      )
    }

    const bodies = new Map<string, Memory>()
    for (const [id, memory] of fulfilled) bodies.set(id, memory)
    const errors = new Map<string, unknown>()
    for (const { key, error } of failures) errors.set(key, error)

    const sections = targets.map((target) => {
      if (!target.ok) {
        return `### (unresolved: ${target.input})\n*${target.message}*`
      }

      const id = target.id
      const memory = bodies.get(id)
      if (memory) return formatExpandedMemory(memory)
      const error = errors.get(id)
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown error")
      return `### (unresolved: ${id})\n*${message}*`
    })

    const unresolvedCount = targets.length - fulfilled.length
    const header =
      unresolvedCount > 0
        ? `Expanded ${fulfilled.length}/${targets.length} memories (${unresolvedCount} unresolved):`
        : `Expanded ${fulfilled.length} ${fulfilled.length === 1 ? "memory" : "memories"}:`

    const response: ToolResult = {
      content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
      costOutputs: { memoriesReturned: fulfilled.length },
    }

    // Citation-as-evidence. `expand` fetches a
    // memory's body for the agent to read directly — that is a cite.
    // Touches only the rows that hydrated successfully; rows that
    // 404'd / errored are already reported as `(unresolved: ...)` and
    // touching them would duplicate the failure mode without any
    // signal value.
    const fulfilledMemories = fulfilled.map(([, memory]) => memory)
    await fireTouchOnRead(services.memories, fulfilledMemories, "kennen-memory (expand)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

function resolveExpandTarget(services: KennenServices, input: string): ExpandTarget {
  if (!isMemoryResultHandle(input)) return { ok: true, input, id: input }

  const store = services.memoryResultHandles
  if (!store) {
    return {
      ok: false,
      input,
      message:
        `Result handle ${input} is not available in this MCP process. ` +
        "Run kennen-query recall/search again and use a returned handle.",
    }
  }

  const resolved = store.resolve(input)
  if (!resolved.ok) {
    return { ok: false, input, message: resolved.message }
  }
  return { ok: true, input, id: resolved.id }
}

/**
 * Render one hydrated memory for `kennen-memory action='expand'` output.
 * Mirrors the meta-line shape used by `kennen-query action='recall'` /
 * `kennen-query action='search'` so agents scanning across
 * triage listings and expanded bodies see a uniform header line. Empty
 * `content` still renders the header (the memory exists; the body is just
 * blank) rather than collapsing the row.
 */
function formatExpandedMemory(m: Memory): string {
  const meta = [
    `ID: ${m.id}`,
    m.source,
    m.kind !== "note" ? m.kind : null,
    m.status !== "informational" ? m.status : null,
    m.updatedAt.split("T")[0],
  ]
    .filter(Boolean)
    .join(" | ")
  const body = m.content ? `\n\n${m.content}` : ""
  return `### ${m.title}\n*${meta}*\nUse this ID for citations or follow-up expand calls: \`${m.id}\`${body}`
}
