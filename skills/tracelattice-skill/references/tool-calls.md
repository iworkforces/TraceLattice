# Wrap a real tool run (suspend and resume)

This is optional and works only when the server operator has registered the tool. `tool_name` is checked against the server's own registry: `sequentialthinking_tools` itself plus `*.tool.md` definitions in the server's tool directories. Listing a tool in `available_mcp_tools` does not register it. An unregistered name returns `UNKNOWN_TOOL`.

```jsonl
{"session_id": "cache-key-grep-0c6e9b12", "thought": "Search for the cache key builder.", "thought_number": 1, "total_thoughts": 3, "thought_type": "tool_call", "tool_name": "Grep", "tool_arguments": {"pattern": "cacheKey"}}
{"session_id": "cache-key-grep-0c6e9b12", "thought": "Grep found the builder at src/cache.ts:12.", "thought_number": 2, "total_thoughts": 3, "thought_type": "tool_observation", "continuation_token": "<continuation_token from the suspended response>", "tool_result": {"matches": ["src/cache.ts:12"]}}
```

The `tool_call` response is a short envelope, not the usual body: `status: "suspended"`, `continuation_token`, `expires_at`, and an echo of `tool_name`, `tool_arguments`, `thought_number`, `total_thoughts` and `session_id`.

Run the tool yourself right away, then send the `tool_observation` with the token. The token works once, only in the session that issued it, and expires at `expires_at` (epoch milliseconds, 60 seconds after the call by default).

If you get `UNKNOWN_TOOL`, or the token expired, do not fight it. Record the tool run as ordinary thoughts instead: say what you will run, run it, and put the result in the next thought. The chain loses one edge kind and nothing else.
