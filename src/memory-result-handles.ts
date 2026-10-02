import { createHash } from "node:crypto"

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MAX_RESULT_SETS = 200

export const MEMORY_RESULT_HANDLE_PATTERN = /^(rs_[0-9a-f]{16}):m([1-9][0-9]*)$/u

export interface MemoryResultHandleStoreOptions {
  ttlMs?: number
  maxResultSets?: number
  now?: () => number
}

export interface MemoryResultHandleEntry {
  id: string
  handle: string
}

export interface MemoryResultSetRegistration {
  resultSetId: string
  entries: MemoryResultHandleEntry[]
  handles: string[]
}

export type MemoryResultHandleResolution =
  | { ok: true; id: string }
  | { ok: false; message: string }

interface StoredResultSet {
  ids: string[]
  expiresAt: number
  touchedAt: number
}

export function isMemoryResultHandle(value: string): boolean {
  return MEMORY_RESULT_HANDLE_PATTERN.test(value)
}

export function parseMemoryResultHandle(
  value: string
): { resultSetId: string; index: number } | null {
  const match = MEMORY_RESULT_HANDLE_PATTERN.exec(value)
  if (!match) return null
  return {
    resultSetId: match[1],
    index: Number(match[2]) - 1,
  }
}

export class MemoryResultHandleStore {
  private readonly ttlMs: number
  private readonly maxResultSets: number
  private readonly now: () => number
  private readonly resultSets = new Map<string, StoredResultSet>()

  constructor(options: MemoryResultHandleStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxResultSets = options.maxResultSets ?? DEFAULT_MAX_RESULT_SETS
    this.now = options.now ?? (() => Date.now())
  }

  register(ids: readonly string[]): MemoryResultSetRegistration {
    const now = this.now()
    this.pruneExpired(now)

    const resultSetId = createResultSetId(ids)
    const stored: StoredResultSet = {
      ids: [...ids],
      expiresAt: now + this.ttlMs,
      touchedAt: now,
    }
    this.resultSets.set(resultSetId, stored)
    this.trimToMax()

    const entries = ids.map((id, index) => ({
      id,
      handle: `${resultSetId}:m${index + 1}`,
    }))
    return {
      resultSetId,
      entries,
      handles: entries.map((entry) => entry.handle),
    }
  }

  resolve(handle: string): MemoryResultHandleResolution {
    const parsed = parseMemoryResultHandle(handle)
    if (!parsed) {
      return {
        ok: false,
        message: `${handle} is not a memory result handle.`,
      }
    }

    const now = this.now()
    this.pruneExpired(now)

    const resultSet = this.resultSets.get(parsed.resultSetId)
    if (!resultSet) {
      return {
        ok: false,
        message:
          `Result handle ${handle} is not available in this MCP process. ` +
          "Run kennen-query recall/search again and use a returned handle.",
      }
    }

    const id = resultSet.ids[parsed.index]
    if (id === undefined) {
      return {
        ok: false,
        message:
          `Result handle ${handle} is outside result set ${parsed.resultSetId}. ` +
          "Use one of the handles shown in the result list.",
      }
    }

    resultSet.touchedAt = now
    return { ok: true, id }
  }

  clear(): void {
    this.resultSets.clear()
  }

  private pruneExpired(now: number): void {
    for (const [resultSetId, resultSet] of this.resultSets) {
      if (resultSet.expiresAt <= now) {
        this.resultSets.delete(resultSetId)
      }
    }
  }

  private trimToMax(): void {
    if (this.resultSets.size <= this.maxResultSets) return

    const ordered = Array.from(this.resultSets.entries()).sort(
      ([, a], [, b]) => a.touchedAt - b.touchedAt
    )
    for (const [resultSetId] of ordered) {
      if (this.resultSets.size <= this.maxResultSets) break
      this.resultSets.delete(resultSetId)
    }
  }
}

function createResultSetId(ids: readonly string[]): string {
  const hash = createHash("sha256").update(ids.join("\0")).digest("hex")
  return `rs_${hash.slice(0, 16)}`
}
