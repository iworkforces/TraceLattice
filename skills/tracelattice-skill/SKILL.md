---
name: tracelattice-skill
description: Use the TraceLattice MCP server's `sequentialthinking_tools` tool to work through hard problems as an explicit, checkable chain of thoughts (decompose, hypothesize, verify, branch, backtrack, synthesize) and act on the server's feedback after every step. Use this whenever a task is too tangled for one pass - debugging with several possible causes, architecture or design trade-offs, multi-step plans, risky refactors and migrations, investigations where evidence must be tracked - or whenever the user says "think step by step", "think this through", "sequential thinking", or mentions TraceLattice. Also read it when a `sequentialthinking_tools` call returns an error, a `warnings` entry, or a `reasoning_hints` entry you are not sure how to handle.
---

# TraceLattice sequential thinking

TraceLattice exposes one MCP tool, `sequentialthinking_tools`. Your client may show it with a server prefix. Each call records one thought that you wrote and returns feedback about the shape of the chain so far.

Three facts set the whole workflow:

- The server does not think and does not run tools. You write every thought.
- The server never sends thought text back, and there is no call that reads the history. The content of the reasoning lives in your context. The server keeps the structure.
- The feedback is the point. A call whose response you do not read is a wasted round trip.

So the loop is: send a typed thought, read the response, let it change the next thought.

## When it pays off

Use it when being wrong is likely or costly: several competing explanations, a plan with dependencies, a design choice with real trade-offs, a claim that needs evidence before you act on it. Skip it for questions you can answer directly. Every thought is a tool round trip, and five untyped thoughts in a row give you nothing a scratchpad would not.

## The loop

1. Make up a unique `session_id` for the task (rule 1 below) and send that exact string on every call of the chain.
2. Send one thought. Four fields are required: `session_id`, `thought`, `thought_number`, `total_thoughts`.
3. Read the response in this order: is it an error, are there `warnings`, are there `reasoning_hints`, what does `strategy_hint` say.
4. End with a `synthesis` thought that sets `next_thought_needed` to `false`. Then write the answer yourself.

```json
{
	"session_id": "cache-bug-5d2a81c3",
	"thought": "Split the bug: read path (key construction) and write path (invalidation).",
	"thought_number": 1,
	"total_thoughts": 6,
	"thought_type": "decomposition"
}
```

## Rules that keep the chain intact

Each of these is a way a chain breaks without an error telling you.

1. **One unique `session_id` per task, on every call.** There is no default session, and the server finds a session by its name alone. A plain name such as "debug" or "task-1" may already hold an earlier chain, and your thoughts would be appended to it. So build the id once, before thought 1: a short task slug plus a suffix you make up for this chain, such as `cache-stale-read-7f3a9c2e` (8 random hex characters; a full UUID also works). Use letters, digits, `-` and `_` only, at most 100 characters. Then send that exact string on every call, because a different suffix is a different, empty session. Hints, statistics and branches are scoped to the session, so give each independent problem, and each subagent, its own id. Send the calls of one session one at a time.
2. **Number thoughts 1, 2, 3 and never reuse a number**, including inside branches and revisions. The server accepts a repeated number, but every reference is by number. Once two thoughts share a number, references to it are ambiguous: they are dropped with a warning, or the call is rejected.
3. **A rejected call records nothing.** Fix it and resend with the same `thought_number`.
4. **References must point at thoughts that already exist.** `revises_thought`, `branch_from_thought`, `synthesis_sources`, `merge_from_thoughts` and `merge_branch_ids` do not fail on an unknown target. The thought is stored without the link, and `warnings` says `Dropped dangling ...` or `Filtered dangling ...`. Check `warnings` on every response.
5. **`total_thoughts` is an estimate.** Raise it when the problem grows. If `thought_number` passes it, the server raises it for you and adds a `[TOTAL_THOUGHTS_ADJUSTED]` warning, which is harmless.
6. **`reset_state: true` deletes the session's whole chain** before it records the thought. Send it only on thought 1 of a deliberate restart, never to "refresh" a chain in progress.
7. **A session idle for 30 minutes expires.** The next call returns `SESSION_EXPIRED`; it does not quietly start an empty chain. Continue under a new `session_id` and open with a thought that restates what was established, or restart the old id with `reset_state: true` on thought 1. A server restart is different: the old id is accepted and may start empty. If `thought_history_length` comes back lower than you expect, the chain is gone, so restate what was established and carry on.
8. **Put an honest `confidence` (0 to 1) on hypotheses and conclusions.** A verification that carries a result is rejected when its target has no confidence, and the server scores your stated confidence against the recorded outcomes.

## Choosing a thought type

Set `thought_type` on every thought. The hints and quality signals are computed from the types, so an untyped chain gets noise instead of feedback.

| `thought_type`                  | Use it to                                  | Fields to add                                                                                   |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `regular` (default)             | Make a plain analysis step                 | none                                                                                            |
| `decomposition`                 | Split the problem into parts               | none                                                                                            |
| `assumption`                    | State something you take as given          | `confidence`                                                                                    |
| `hypothesis`                    | Propose a candidate answer                 | `hypothesis_id`, `confidence`                                                                   |
| `verification`                  | Record the check of one earlier thought    | `verification_target`, `verification_result` (1 held, 0 refuted), `hypothesis_id`, `confidence` |
| `critique`                      | Attack an earlier thought                  | `verification_target`                                                                           |
| `synthesis`                     | Combine earlier thoughts into a conclusion | `synthesis_sources`, plus `merge_from_thoughts` and `merge_branch_ids` when it absorbs a branch |
| `meta`                          | Comment on the process, not the problem    | `meta_observation`                                                                              |
| `backtrack`                     | Retract an earlier thought                 | `backtrack_target`                                                                              |
| `tool_call`, `tool_observation` | Wrap a real tool run                       | see "Wrap a real tool run"                                                                      |

## Patterns

### Test a hypothesis

State it with an id and a confidence, gather the evidence, then record the outcome against the hypothesis's thought number.

```jsonl
{"session_id": "cache-key-check-e41b7a09", "thought": "Hypothesis: the cache key omits the tenant id.", "thought_number": 1, "total_thoughts": 3, "thought_type": "hypothesis", "hypothesis_id": "h-key", "confidence": 0.6}
{"session_id": "cache-key-check-e41b7a09", "thought": "Read src/cache.ts:12: key is built from userId only. Hypothesis holds.", "thought_number": 2, "total_thoughts": 3, "thought_type": "verification", "hypothesis_id": "h-key", "verification_target": 1, "verification_result": 1, "confidence": 0.9}
```

The second response shows the link landed: `graph_context.outbound` holds `{"thought_number": 1, "kind": "verifies"}` and `reasoning_stats.unresolved_hypothesis_count` is 0. Verify within three thoughts of the hypothesis, or a hint starts asking for it. A result of 0 marks the hypothesis refuted, and later thoughts that build on it are flagged until you revise or backtrack them.

### Compare alternatives with branches

Open a branch with both `branch_from_thought` and `branch_id`. Continue it with `branch_id` alone, and finish one branch before you start the next, because a continuation is linked to whichever thought arrived just before it. To return to a branch after working elsewhere, send `branch_from_thought` (the last thought of that branch) together with the same `branch_id`. The response's `branches` array lists the branch ids the session knows.

```jsonl
{"session_id": "retry-policy-4b1d07ea", "thought": "Two candidate designs for the retry policy.", "thought_number": 1, "total_thoughts": 6, "thought_type": "decomposition"}
{"session_id": "retry-policy-4b1d07ea", "thought": "Option A: exponential backoff in each client is enough.", "thought_number": 2, "total_thoughts": 6, "branch_from_thought": 1, "branch_id": "opt-a", "thought_type": "hypothesis", "hypothesis_id": "h-a", "confidence": 0.5}
{"session_id": "retry-policy-4b1d07ea", "thought": "Three clients would each carry the retry logic, and two already disagree on limits. Option A fails.", "thought_number": 3, "total_thoughts": 6, "branch_id": "opt-a", "thought_type": "verification", "hypothesis_id": "h-a", "verification_target": 2, "verification_result": 0, "confidence": 0.8}
{"session_id": "retry-policy-4b1d07ea", "thought": "Option B: retry once, in the gateway.", "thought_number": 4, "total_thoughts": 6, "branch_from_thought": 1, "branch_id": "opt-b", "thought_type": "hypothesis", "hypothesis_id": "h-b", "confidence": 0.7}
{"session_id": "retry-policy-4b1d07ea", "thought": "The gateway already owns timeouts and sees every call. Option B holds.", "thought_number": 5, "total_thoughts": 6, "branch_id": "opt-b", "thought_type": "verification", "hypothesis_id": "h-b", "verification_target": 4, "verification_result": 1, "confidence": 0.85}
{"session_id": "retry-policy-4b1d07ea", "thought": "Choose B and reuse the backoff curve from A inside the gateway.", "thought_number": 6, "total_thoughts": 6, "thought_type": "synthesis", "synthesis_sources": [3, 5], "merge_from_thoughts": [3, 5], "merge_branch_ids": ["opt-a", "opt-b"], "confidence": 0.85, "next_thought_needed": false}
```

A plain thought sent after a branch is linked in arrival order, to the last thought of that branch. To bring a branch's result back, name it: close with a `synthesis` that lists the branch thoughts in `merge_from_thoughts` and the branch in `merge_branch_ids`.

### Fix a wrong turn

- **Refine it.** Send a new thought with `is_revision: true` and `revises_thought: N`. The original stays in history and the new thought is linked to it as its revision.
- **Retract it.** Send `thought_type: "backtrack"` with `backtrack_target: N`. Thought N stays in history but is excluded from statistics and quality signals. The target must be an existing, unique number no greater than the current `thought_number`.

Use backtrack when the thought was wrong, and revision when it was incomplete.

### Plan tool use

Describe the next real action in `current_step`, and what follows in `remaining_steps`. The server only records this; you run the tools.

```json
{
	"session_id": "cache-key-fix-a83f20d6",
	"thought": "Locate where the cache key is built before changing it.",
	"thought_number": 1,
	"total_thoughts": 4,
	"available_mcp_tools": ["Grep", "Read"],
	"current_step": {
		"step_description": "Find cache key construction",
		"recommended_tools": [
			{
				"tool_name": "Grep",
				"confidence": 0.9,
				"rationale": "Literal search for cacheKey",
				"priority": 1
			}
		],
		"expected_outcome": "File and line of the key builder"
	},
	"remaining_steps": ["Read the builder", "Add tenant id to the key"]
}
```

`recommended_tools` is plural and is an array, and each entry needs `tool_name`, `confidence` and `rationale`. Send `available_mcp_tools` and `available_skills` once; the session remembers them and echoes them back.

### Wrap a real tool run (suspend and resume)

This is optional and works only when the server operator has registered the tool. `tool_name` is checked against the server's own registry: `sequentialthinking_tools` itself plus `*.tool.md` definitions in the server's tool directories. Listing a tool in `available_mcp_tools` does not register it. An unregistered name returns `UNKNOWN_TOOL`.

```jsonl
{"session_id": "cache-key-grep-0c6e9b12", "thought": "Search for the cache key builder.", "thought_number": 1, "total_thoughts": 3, "thought_type": "tool_call", "tool_name": "Grep", "tool_arguments": {"pattern": "cacheKey"}}
{"session_id": "cache-key-grep-0c6e9b12", "thought": "Grep found the builder at src/cache.ts:12.", "thought_number": 2, "total_thoughts": 3, "thought_type": "tool_observation", "continuation_token": "<continuation_token from the suspended response>", "tool_result": {"matches": ["src/cache.ts:12"]}}
```

The `tool_call` response is a short envelope, not the usual body:

```json
{
	"status": "suspended",
	"continuation_token": "...",
	"tool_name": "Grep",
	"tool_arguments": { "pattern": "cacheKey" },
	"expires_at": 1794492690247,
	"thought_number": 1,
	"total_thoughts": 3,
	"session_id": "cache-key-grep-0c6e9b12"
}
```

Run the tool yourself right away, then send the `tool_observation` with the token. The token works once, only in the session that issued it, and expires at `expires_at` (epoch milliseconds, 60 seconds after the call by default).

If you get `UNKNOWN_TOOL`, or the token expired, do not fight it. Record the tool run as ordinary thoughts instead: say what you will run, run it, and put the result in the next thought. The chain loses one edge kind and nothing else.

## Reading the response

A success is a JSON object. These are the fields worth acting on.

| Field                                         | What it tells you                                                                                                                   | What to do                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warnings`                                    | Up to 3 strings. A reference was dropped or filtered, or `total_thoughts` was adjusted                                              | For `Dropped` or `Filtered`: the thought was stored without that link. Send a corrected thought, usually a new `synthesis` or a revision with the right numbers |
| `reasoning_hints`                             | Up to 3 strings about weak spots in the chain. A pattern that fired stays quiet for the next 2 thought numbers, then can fire again | Act on each one once; see the table below                                                                                                                       |
| `strategy_hint.action`                        | `continue` or `terminate`                                                                                                           | See "Knowing when to stop"                                                                                                                                      |
| `thought_history_length`                      | Thoughts recorded in this session                                                                                                   | It grows by 1 per accepted call. If it did not, the call was rejected                                                                                           |
| `branches`                                    | Branch ids known to the session                                                                                                     | Confirm the branch you opened is listed                                                                                                                         |
| `graph_context`                               | `inbound` and `outbound` links of this thought, each with `thought_number` and `kind`                                               | Quick proof that a reference landed                                                                                                                             |
| `reasoning_stats.unresolved_hypothesis_count` | Hypotheses with no verification yet                                                                                                 | Bring it to 0 before concluding, or say why not                                                                                                                 |
| `confidence_signals.structural_quality`       | 0 to 1 score of the chain's shape                                                                                                   | See below                                                                                                                                                       |

`confidence_signals.quality_components` says which part of the shape is weak: `verification_coverage` (hypotheses left unverified), `type_diversity` (every thought has the same type), `depth_efficiency`, `confidence_stability`. One unverified hypothesis pulls `structural_quality` down sharply until you verify it. The score measures the structure of the chain, not whether the conclusion is true, so use it to find gaps and do not write thoughts just to raise it.

### What each hint asks for

| Hint says                                                          | Do this                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `3+ consecutive thoughts ... without verification`                 | Check the claim the chain rests on and record a `verification`                                                                 |
| `Hypothesis at thought N has not been verified within 3 thoughts`  | Verify N now, with `verification_target: N` and a result. A target takes one result, so if N already has one the hint is stale |
| `5+ thoughts with no critique or branching`                        | Write a `critique` of your leading idea, or branch to a real alternative                                                       |
| `4+ consecutive 'regular' thoughts`                                | Type your thoughts; you are losing the feedback                                                                                |
| `Thought(s) X build on hypothesis at thought N, which was refuted` | Backtrack or revise X                                                                                                          |
| `Critique at thought C of thought T has not been addressed`        | Revise T, or verify it against the critique                                                                                    |
| `Confidence decreasing across thoughts`                            | Stop and send a `meta` thought: is the approach wrong, or only the last step                                                   |

Hints describe the whole history, including stretches you have already repaired. A hint can come back after its cooldown and name the same thought numbers again. Act on each hint once. When it repeats with the same numbers after you did what it asked, it is stale: ignore it, and do not add thoughts to silence it.

### Knowing when to stop

With the default strategy, `strategy_hint` mirrors your own flag: `{"action": "continue"}` until you send `next_thought_needed: false`, then `{"action": "terminate", "reason": "next_thought_needed=false"}`. The hint is advisory. The server accepts more thoughts after `terminate`, so add one if you find a gap.

A server configured with the `tot` strategy decides differently. `continue` arrives with `nextHint: "explore frontier"`, `terminate` arrives with the reason `confidence threshold`, `plateau` or `depth cap`, and the hint does not follow `next_thought_needed`. It scores a thought from `confidence` (0 when omitted) and `quality_score` (0.5 when omitted), so set both honestly. A `branch` action is a suggestion to open a branch from `fromThought`; nothing is created until you send that thought.

In both cases you are done when the checklist at the end holds.

## Errors

Every failure has `isError: true` and records nothing. There are two shapes.

**Plain text starting with `Invalid arguments for tool`.** The input did not match the schema. The text holds a JSON array; read `message` and the last `key` in `path`. Usual causes: `session_id` missing or set to the retired value `__global__`, an unknown `thought_type`, `recommended_tool` written in the singular, a number below 1.

**JSON with `code`, `error`, `message` and `status: "failed"`.** The input was well formed but the server refused it.

| `code`                  | Message contains                                     | Fix                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`      | `requires verification_target`                       | A `verification` with a result must name its target                                                                                                   |
| `VALIDATION_ERROR`      | `verification_target N is missing` or `is ambiguous` | Point at an existing number that was used once                                                                                                        |
| `VALIDATION_ERROR`      | `verification_target must have confidence`           | The target has no `confidence`. Send a revision of it that carries `confidence` and verify the number of that revision, or drop `verification_result` |
| `VALIDATION_ERROR`      | `already has a recorded result`                      | A target takes one result. Do not resend. If you changed your mind, revise or backtrack the hypothesis                                                |
| `VALIDATION_ERROR`      | `requires backtrack_target`                          | Add `backtrack_target`                                                                                                                                |
| `INVALID_BACKTRACK`     | `must be <=`, `does not exist`, `is ambiguous`       | Target an existing, unique, earlier thought                                                                                                           |
| `VALIDATION_ERROR`      | `missing continuation_token`                         | A `tool_observation` needs the token from its `tool_call`                                                                                             |
| `VALIDATION_ERROR`      | `requires the ... feature flag`                      | That type is switched off on this server. Use the type the message suggests, or `regular`                                                             |
| `VALIDATION_ERROR`      | `Thought id already exists`                          | Leave `id` out; the server generates it                                                                                                               |
| `INVALID_TOOL_CALL`     | `missing required tool_name`                         | Add `tool_name`                                                                                                                                       |
| `UNKNOWN_TOOL`          | `not registered with the server`                     | Record the tool run as ordinary thoughts                                                                                                              |
| `SUSPENSION_NOT_FOUND`  | `Suspension token not found`                         | The token was already used, or belongs to another session. Record the result as a `regular` thought                                                   |
| `SUSPENSION_EXPIRED`    | `Suspension token expired`                           | Same: record the result as a `regular` thought                                                                                                        |
| `SESSION_EXPIRED`       | `has expired`                                        | New `session_id`, or `reset_state: true` on thought 1                                                                                                 |
| `SESSION_ACCESS_DENIED` | `Access denied to session`                           | The id belongs to another client. Choose a different `session_id`                                                                                     |

Four codes are operational and say nothing about your input:

- `LOCK_TIMEOUT`, `PERSISTENCE_BACKLOG_FULL`: wait and resend the same call.
- `MAX_SESSIONS_REACHED`: the server holds its maximum of live sessions and cannot admit a new one. A different `session_id` hits the same limit, so wait and resend.
- `SESSION_LIFECYCLE_CLOSED`: the message names a phase. `resetting`, `reset_failed`, `evicting` and `eviction_failed` concern this session only: retry once, then continue under a new `session_id`. `shutting_down` and `stopped` mean the whole server is going away and no id will work.

After two failed retries, stop calling the tool. Finish the reasoning without it and tell the user the thinking server was unavailable.

## Worked example

A stale-read bug with two candidate causes, taken from decomposition to a merged conclusion in six thoughts.

```jsonl
{"session_id": "cache-stale-read-7f3a9c2e", "thought": "Split the bug: read path (key construction) and write path (invalidation).", "thought_number": 1, "total_thoughts": 6, "thought_type": "decomposition"}
{"session_id": "cache-stale-read-7f3a9c2e", "thought": "Hypothesis: the read path builds the cache key without the tenant id.", "thought_number": 2, "total_thoughts": 6, "thought_type": "hypothesis", "hypothesis_id": "h-read", "confidence": 0.6}
{"session_id": "cache-stale-read-7f3a9c2e", "thought": "Alternative: the write path races and skips invalidation.", "thought_number": 3, "total_thoughts": 6, "branch_from_thought": 1, "branch_id": "alt-write", "thought_type": "hypothesis", "hypothesis_id": "h-write", "confidence": 0.4}
{"session_id": "cache-stale-read-7f3a9c2e", "thought": "Write path holds the row lock across invalidation. No race.", "thought_number": 4, "total_thoughts": 6, "branch_id": "alt-write", "thought_type": "verification", "hypothesis_id": "h-write", "verification_target": 3, "verification_result": 0, "confidence": 0.8}
{"session_id": "cache-stale-read-7f3a9c2e", "thought": "src/cache.ts:12 builds the key from userId only. Two tenants collide.", "thought_number": 5, "total_thoughts": 6, "thought_type": "verification", "hypothesis_id": "h-read", "verification_target": 2, "verification_result": 1, "confidence": 0.9}
{"session_id": "cache-stale-read-7f3a9c2e", "thought": "Cause: tenant id missing from the read key. Fix the key; the write path is sound.", "thought_number": 6, "total_thoughts": 6, "thought_type": "synthesis", "synthesis_sources": [2, 5], "merge_from_thoughts": [4], "merge_branch_ids": ["alt-write"], "confidence": 0.9, "next_thought_needed": false}
```

What the last response shows, trimmed to the fields that matter:

```json
{
	"thought_number": 6,
	"thought_history_length": 6,
	"branches": ["alt-write"],
	"reasoning_stats": {
		"hypothesis_count": 2,
		"verified_hypothesis_count": 2,
		"unresolved_hypothesis_count": 0,
		"total_merges": 1
	},
	"reasoning_hints": ["3+ consecutive thoughts (1-3) without verification"],
	"strategy_hint": { "action": "terminate", "reason": "next_thought_needed=false" },
	"session_id": "cache-stale-read-7f3a9c2e"
}
```

There is no `warnings` key, so every reference landed. Both hypotheses are resolved, one confirmed and one refuted, and the refuted branch is merged into the conclusion instead of being left hanging. The one hint is stale: it names thoughts 1-3, and that stretch was checked at thoughts 4 and 5, so it needs no further thought.

## Before you answer

- `reasoning_stats.unresolved_hypothesis_count` is 0, or you can say why a hypothesis stays open.
- No `warnings` entry is left unhandled, and no hint about a refuted hypothesis or an unaddressed critique is outstanding.
- The last thought is a `synthesis` with `synthesis_sources` and `next_thought_needed: false`.
- The answer you write states the conclusion and the evidence. The user cannot see the chain, and the server will not hand it back.
