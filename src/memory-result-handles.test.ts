import { describe, expect, it } from "vitest"
import {
  MemoryResultHandleStore,
  isMemoryResultHandle,
  parseMemoryResultHandle,
} from "./memory-result-handles.js"

describe("MemoryResultHandleStore", () => {
  it("registers deterministic handles for an ordered result set", () => {
    const store = new MemoryResultHandleStore({ now: () => 1000 })

    const first = store.register(["mem-a", "mem-b"])
    const second = store.register(["mem-a", "mem-b"])

    expect(first.resultSetId).toBe(second.resultSetId)
    expect(first.handles).toEqual([`${first.resultSetId}:m1`, `${first.resultSetId}:m2`])
    expect(first.entries).toEqual([
      { id: "mem-a", handle: `${first.resultSetId}:m1` },
      { id: "mem-b", handle: `${first.resultSetId}:m2` },
    ])
  })

  it("resolves handles back to their memory ids", () => {
    const store = new MemoryResultHandleStore({ now: () => 1000 })
    const resultSet = store.register(["mem-a", "mem-b"])

    expect(store.resolve(resultSet.handles[0])).toEqual({ ok: true, id: "mem-a" })
    expect(store.resolve(resultSet.handles[1])).toEqual({ ok: true, id: "mem-b" })
  })

  it("expires result sets by ttl", () => {
    let now = 1000
    const store = new MemoryResultHandleStore({ ttlMs: 50, now: () => now })
    const resultSet = store.register(["mem-a"])

    now = 1051

    expect(store.resolve(resultSet.handles[0])).toEqual({
      ok: false,
      message:
        `Result handle ${resultSet.handles[0]} is not available in this MCP process. ` +
        "Run kennen-query recall/search again and use a returned handle.",
    })
  })

  it("prunes least-recently-touched result sets when the store is full", () => {
    let now = 1000
    const store = new MemoryResultHandleStore({
      maxResultSets: 2,
      now: () => now,
    })
    const first = store.register(["mem-a"])
    now = 1001
    const second = store.register(["mem-b"])
    now = 1002
    store.resolve(first.handles[0])
    now = 1003
    const third = store.register(["mem-c"])

    expect(store.resolve(first.handles[0])).toEqual({ ok: true, id: "mem-a" })
    expect(store.resolve(second.handles[0]).ok).toBe(false)
    expect(store.resolve(third.handles[0])).toEqual({ ok: true, id: "mem-c" })
  })
})

describe("memory result handle parsing", () => {
  it("recognizes the result-set handle shape", () => {
    const handle = "rs_0123456789abcdef:m12"

    expect(isMemoryResultHandle(handle)).toBe(true)
    expect(parseMemoryResultHandle(handle)).toEqual({
      resultSetId: "rs_0123456789abcdef",
      index: 11,
    })
    expect(isMemoryResultHandle("not-a-handle")).toBe(false)
    expect(parseMemoryResultHandle("rs_0123456789abcdef:m0")).toBeNull()
  })
})
