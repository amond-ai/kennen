import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  debugLogAutoFactFailure,
  debugLogFactTouchFailure,
  debugLogTouchFailure,
  formatDispatchError,
  toolError,
} from "./helpers.js"
import { WriteBudgetExceededError } from "../notion/rate-limit.js"
import { KennenError } from "../errors.js"

// Wrapper around `vi.spyOn(process.stderr, "write")` that returns the
// spy at the loose `MockInstance` shape vitest infers. The
// `WriteStream.write(...)` overload set doesn't unify cleanly with
// the `vi.spyOn<T, K>` generic, so a type-literal annotation on the
// `let stderr` variable wouldn't compile; pulling the call into a
// helper lets `ReturnType<typeof spyStderr>` resolve through TS's
// inference path instead.
function spyStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true)
}

describe("toolError", () => {
  it("redacts sensitive substrings before returning MCP error content", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const token = "secret_aaaaaaaaaaaaaaaaaaaaaaaa"
    const result = toolError(
      new Error(
        `APIError body={"token":"${token}","page":"${pageId}"} page=${pageId} headers={Authorization: Bearer ${token}} status=500`
      )
    )

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Error: APIError body=<redacted> page=<page-id> headers=<redacted> status=500",
        },
      ],
      isError: true,
    })
    expect(result.content[0].text).not.toContain(pageId)
    expect(result.content[0].text).not.toContain(token)
  })

  it("redacts thrown non-Error values before returning MCP error content", () => {
    const pageId = "fedcba9876543210fedcba9876543210"
    const result = toolError(`Failed to load page ${pageId}`)

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: Failed to load page <page-id>" }],
      isError: true,
    })
  })

  it("keeps retryable metadata while redacting the user-visible message", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const err = new Error(`Transient failure for page ${pageId}`) as Error & {
      code: string
      retryable: true
    }
    err.code = "project_scope_retry"
    err.retryable = true

    const result = toolError(err)

    expect(result.content[0].text).toBe(
      'Error: Transient failure for page <page-id>\n\n```json\n{"code":"project_scope_retry","retryable":true}\n```'
    )
    expect(result.content[0].text).not.toContain(pageId)
  })

  it("does not truncate recovery guidance in MCP error content", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const recovery = `${"Inspect the saved row before retrying. ".repeat(20)}final recovery marker`
    const result = toolError(new Error(`Partial failure on ${pageId}. ${recovery}`))

    expect(result.content[0].text).toContain("<page-id>")
    expect(result.content[0].text).not.toContain(pageId)
    expect(result.content[0].text).toContain("final recovery marker")
    expect(result.content[0].text).not.toContain("…(truncated)")
  })

  it("preserves write-budget errors verbatim", () => {
    const err = new WriteBudgetExceededError(
      "kennen-memory.abcdef0123456789abcdef0123456789",
      10,
      11
    )

    expect(toolError(err)).toEqual({
      content: [{ type: "text", text: err.message }],
      isError: true,
    })
  })

  it("renders KennenError kind and redacted details as structured metadata", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const token = "secret_aaaaaaaaaaaaaaaaaaaaaaaa"
    const err = new KennenError("memory-create-partial", `Partial failure on ${pageId}`, {
      pageId,
      cleanedUp: false,
      bodyWriteCauseMessage: `body=${JSON.stringify({ token, pageId })}`,
      cleanupCauseMessage: `headers={Authorization: Bearer ${token}}`,
    })

    const result = toolError(err)
    const text = result.content[0].text

    expect(text).toContain("Error: Partial failure on <page-id>")
    expect(text).toContain('"kind":"memory-create-partial"')
    expect(text).toContain('"pageId":"<page-id>"')
    expect(text).toContain('"bodyWriteCauseMessage":"body=<redacted>"')
    expect(text).toContain('"cleanupCauseMessage":"headers=<redacted>"')
    expect(text).not.toContain(pageId)
    expect(text).not.toContain(token)
  })
})

describe("debugLogAutoFactFailure (0.8.0/07)", () => {
  it("is a no-op when KENNEN_DEBUG is unset (zero stderr writes)", () => {
    // The helper exists for opt-in operator observability — running
    // without `KENNEN_DEBUG=1` must not flood stderr on every save
    // because the auto-emit branch fans out per-entity. Same posture
    // as the shared partial-failure logger.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("KENNEN_DEBUG", "")
    try {
      debugLogAutoFactFailure("save", "mem-1", "PR #1234", new Error("notion 429"))
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("writes one stderr line under KENNEN_DEBUG=1 with source/kind/memoryId/entity/error fields", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("KENNEN_DEBUG", "1")
    try {
      debugLogAutoFactFailure("save", "mem-1", "PR #1234", new Error("notion 429"))
      expect(write).toHaveBeenCalledTimes(1)
      const line = write.mock.calls[0][0] as string
      // `kind` defaults to `create` for the save-time call site; the
      // field is always present so log parsers can rely on a stable
      // key set across both save creates and update creates /
      // invalidates (issue #491).
      expect(line).toBe(
        "[kennen] auto-fact-failure: source=save kind=create memoryId=mem-1 entity=PR #1234 error=notion 429\n"
      )
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("emits kind=invalidate for the stale-fact invalidate path on update (issue #491)", () => {
    // Diff-and-invalidate on update needs a separate failure
    // discriminator from the per-entity create path so an operator
    // grepping `auto-fact-failure: kind=invalidate` can isolate
    // sustained issues with the invalidate write from transient
    // dedup races on create.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("KENNEN_DEBUG", "1")
    try {
      debugLogAutoFactFailure(
        "update",
        "mem-1",
        "PR #1234",
        new Error("notion 503"),
        "invalidate"
      )
      const line = write.mock.calls[0][0] as string
      expect(line).toContain("source=update")
      expect(line).toContain("kind=invalidate")
      expect(line).toContain("memoryId=mem-1")
      expect(line).toContain("entity=PR #1234")
      expect(line).toContain("error=notion 503")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("carries source=update for the diff-driven re-emission landed via DEFERRED-03 + #491", () => {
    // `update` is the call-site discriminator for the re-emission
    // path landed via DEFERRED-03 (and reshaped by issue #491 from
    // add-only into symmetric diff-and-invalidate) — pin the value
    // here so the helper's union doesn't drift if a future
    // contributor renames the call site.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("KENNEN_DEBUG", "1")
    try {
      debugLogAutoFactFailure("update", "mem-2", "AuthService", new Error("dedup race"))
      const line = write.mock.calls[0][0] as string
      expect(line).toContain("source=update")
      expect(line).toContain("memoryId=mem-2")
      expect(line).toContain("entity=AuthService")
      expect(line).toContain("error=dedup race")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("stringifies non-Error rejections so a thrown string still surfaces", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("KENNEN_DEBUG", "1")
    try {
      debugLogAutoFactFailure("save", "mem-3", "Foo", "bare-string-throw")
      const line = write.mock.calls[0][0] as string
      expect(line).toContain("error=bare-string-throw")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("replaces ASCII control characters in interpolated fields with spaces (one-event-per-line)", () => {
    // Log aggregators rely on newline-delimited events; if a future
    // tokenizer or memory-id source surfaces a `\n` or `\t` we must
    // not split one logical failure into multiple parsed records.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("KENNEN_DEBUG", "1")
    try {
      debugLogAutoFactFailure(
        "save",
        "mem\n4",
        "Foo\tBar",
        new Error("multi\nline\rerror")
      )
      const line = write.mock.calls[0][0] as string
      // Exactly one terminating newline; control chars in the body
      // collapsed to spaces.
      expect(line.endsWith("\n")).toBe(true)
      expect(line.split("\n")).toHaveLength(2)
      expect(line).toContain("memoryId=mem 4")
      expect(line).toContain("entity=Foo Bar")
      expect(line).toContain("error=multi line error")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })
})
describe("KENNEN_DEBUG redaction routing (issue #488)", () => {
  // Pins the contract that KENNEN_DEBUG-gated stderr emitters in
  // this module routes its error message through `redactDebugError`
  // before writing. Page-id-shaped substrings and forward-compatible
  // SDK leak shapes (`body=`, `headers=`) are scrubbed; the
  // `memoryId=<id>` / `entity=<id>` explicit fields are
  // intentionally NOT redacted because operators need them for
  // triage. Coverage of one helper per shape is sufficient — the
  // routing is the contract, not the per-helper plumbing.

  it("debugLogAutoFactFailure routes through the redactor too (single-pass coverage)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.KENNEN_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      debugLogAutoFactFailure(
        "save",
        "mem-1",
        "PR #1234",
        new Error(`unable to read ${id}`)
      )
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=unable to read <page-id>")
      // Explicit field is still readable.
      expect(line).toContain("memoryId=mem-1")
    } finally {
      delete process.env.KENNEN_DEBUG
      stderr.mockRestore()
    }
  })

  it("debugLogTouchFailure routes through the redactor too", () => {
    // Coverage parity with the other KENNEN_DEBUG emitters in this
    // module — the touch path fires on every read citation, so an
    // SDK error carrying a page id under load would otherwise rain
    // recon-grade detail into stderr.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.KENNEN_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      debugLogTouchFailure("kennen-query", "mem-7", new Error(`page ${id} 429`))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=page <page-id> 429")
      expect(line).toContain("memory=mem-7")
      expect(line).toContain("tool=kennen-query")
    } finally {
      delete process.env.KENNEN_DEBUG
      stderr.mockRestore()
    }
  })

  it("debugLogFactTouchFailure routes through the redactor too", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.KENNEN_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      debugLogFactTouchFailure("kennen-query", "fact-3", new Error(`fact ${id}`))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=fact <page-id>")
      expect(line).toContain("fact=fact-3")
    } finally {
      delete process.env.KENNEN_DEBUG
      stderr.mockRestore()
    }
  })

  describe("clean messages pass through unchanged; explicit fields remain readable", () => {
    // Negative coverage per routing site — a regression that
    // accidentally over-redacts the explicit `memoryId=` / `entity=` /
    // `fact=` interpolations would silently break operator
    // triage. Pin the safe-passthrough contract per emitter.
    //
    // Each test saves the prior `KENNEN_DEBUG` value and restores it in
    // `finally` so a vitest run that already had the env var set
    // (e.g. an outer harness, a watch-mode rerun, or a sibling test
    // that leaked the gate state) doesn't see its value silently
    // deleted out from under it. Mirrors the defensive shape used in
    // `auth/identity.test.ts` and `notion/client.test.ts`.

    let priorDebug: string | undefined
    // Vitest's `MockInstance` generic doesn't unify with the
    // overloaded `WriteStream.write(...)` signature, so the spy is
    // typed via the helper's return shape rather than the
    // narrower `vi.spyOn<...>` form.
    let stderr: ReturnType<typeof spyStderr>

    beforeEach(() => {
      priorDebug = process.env["KENNEN_DEBUG"]
      process.env["KENNEN_DEBUG"] = "1"
      stderr = spyStderr()
    })

    afterEach(() => {
      stderr.mockRestore()
      if (priorDebug === undefined) {
        delete process.env["KENNEN_DEBUG"]
      } else {
        process.env["KENNEN_DEBUG"] = priorDebug
      }
    })

    it("debugLogAutoFactFailure with a clean message preserves memoryId and entity", () => {
      debugLogAutoFactFailure("save", "mem-1", "PR #1234", new Error("notion 429"))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[kennen] auto-fact-failure: source=save kind=create memoryId=mem-1 entity=PR #1234 error=notion 429\n"
      )
    })

    it("debugLogTouchFailure with a clean message preserves memory id and tool", () => {
      debugLogTouchFailure("kennen-query", "mem-1", new Error("notion 429"))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[kennen] touch-failure: memory=mem-1 error=notion 429 tool=kennen-query\n"
      )
    })

    it("debugLogFactTouchFailure with a clean message preserves fact id and tool", () => {
      debugLogFactTouchFailure("kennen-query", "fact-1", new Error("notion 429"))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[kennen] fact-touch-failure: fact=fact-1 error=notion 429 tool=kennen-query\n"
      )
    })
  })
})

describe("formatDispatchError", () => {
  const schema = z.object({ kind: z.enum(["note", "decision"]) })

  it("echoes a rejected primitive value", () => {
    const parsed = schema.safeParse({ kind: "task" }, { reportInput: true })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(formatDispatchError("kennen-memory", parsed.error)).toBe(
      `kennen-memory: kind: Invalid option: expected one of "note"|"decision", received 'task'`
    )
  })

  it("never echoes object or array input", () => {
    for (const kind of [{ secret: "x" }, ["note"]]) {
      const parsed = schema.safeParse({ kind }, { reportInput: true })
      expect(parsed.success).toBe(false)
      if (parsed.success) return
      const message = formatDispatchError("kennen-memory", parsed.error)
      expect(message).not.toContain("received")
      expect(message).not.toContain("secret")
    }
  })

  it("echoes a rejected discriminator value on a single line", () => {
    const union = z.discriminatedUnion("action", [
      z.object({ action: z.literal("save") }),
      z.object({ action: z.literal("search") }),
    ])
    const parsed = union.safeParse({ action: "sav\ne" }, { reportInput: true })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(formatDispatchError("kennen-memory", parsed.error)).toBe(
      `kennen-memory: action: Invalid discriminator value. Expected 'save' | 'search', received 'sav e'`
    )
  })
})
