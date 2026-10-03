---
name: kennen-memory
description: Save and recall cross-session knowledge with the Kennen MCP tools — load project context at session start, record decisions, gotchas, facts, and follow-up tasks, and compare conflicting memories. Use when starting work in a project with a Kennen vault, when making an architectural choice, after discovering a non-obvious gotcha or workaround, when tracking follow-up work, or when the user mentions Kennen, remember this, save this to memory, what did we decide, 기억해, 메모리에 저장, 지난번 결정.
---

# Kennen Memory

Kennen stores knowledge as Notion pages in five databases (Projects, Topics,
Memories, Entities, Facts). The plugin's hooks already inject wake-up context
on the first prompt of a session and autosave learnings on `Stop`; the autosave
is a safety net, so save durable knowledge explicitly with the tools below.

## Session start

The wake-up hook injects project context on the first prompt of a session. Call
`kennen-context action='wake-up'` yourself only when that context is missing
(hooks disabled), or after `/clear` or a topic change, with
`userQuery='<new task prompt>'` so recall is ranked against the new task.

## What to save

| Knowledge                                                    | Tool call                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| Architectural choice, its rationale and alternatives         | `kennen-decision action='create'` (pass `affects: [...]`)     |
| Non-obvious discovery, debugging insight, gotcha, workaround | `kennen-memory action='save'`                                 |
| Durable relationship (`uses`, `depends_on`, `is_a`)          | `kennen-fact action='create'`                                 |
| Follow-up work, open PR, blocked dependency                  | `kennen-task action='create'`; close it as soon as it is done |

- `kennen-fact action='create'` needs provenance: pass `sourceMemoryId` of an
  existing memory, or `agent` and `session` matching a memory saved earlier in
  the same process. Save the supporting memory first.
- Keep a memory `synopsis` to a one-line scan hook (150 characters by default),
  not a summary of the body.
- When a fact goes stale, use `kennen-fact action='invalidate'` rather than
  editing the supporting memory.

## Recall

Use `kennen-query action='search'` to find memories on a topic before
re-deriving something a previous session may already have learned;
`action='recall'` lists recent memories.

## Conflicting memories

When two memories are in tension, call `kennen-memory action='compare'` with
one verdict: `conflicts_with` or `supersedes` (asymmetric — pass
`affectedMemoryId`), or `scoped`, `related`, `compatible`, `not_conflict`
(symmetric). `supersedes` applies only when the affected memory is a decision.

## Do not

- Do not add visible "Key Learnings" sections to replies; the autosave hook
  extracts learnings out of band.
- Do not save secrets, tokens, or credentials.
