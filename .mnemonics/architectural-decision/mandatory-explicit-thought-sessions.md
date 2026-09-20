---
id: 163e1580-ba4a-4c3e-a666-27ff101054b1
created: '2026-09-20T11:13:23.965Z'
modified: '2026-09-20T11:13:23.965Z'
memory_type: architectural-decision
tags:
  - session-id
  - explicit-sessions
  - no-global-session
  - persistence
  - transport
  - lifecycle
  - verification
---
TraceLattice current contract: `session_id` is required end-to-end for thought admission, history, persistence, transport, and lifecycle operations. There is no global or default thought session; retired `__global__` is rejected. Validate the session ID before authorization, session creation, persistence publication, or any mutation. Thought sessions are distinct from MCP `Mcp-Session-Id`, ALS owner identity, and `ConnectionPool` slots. Explicit `resetAll`, `clearAll`, shutdown, and aggregate operations are legitimate administration, not implicit session identity. Do not add compatibility aliases, migration shims, implicit session generation, or fallback routing. Final verification passed 2,749 tests, native 6/6, packed omitted/retired rejection, Sentrux 6125, and an independent APPROVE/HIGH review.
