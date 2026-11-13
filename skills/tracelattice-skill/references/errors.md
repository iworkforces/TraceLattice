# TraceLattice errors

Every failure has `isError: true` and records nothing, so after a fix you resend with the same `thought_number`. There are two shapes.

**Plain text starting with `Invalid arguments for tool`.** The input did not match the schema. The text holds a JSON array; read `message` and the last `key` in `path`. Usual causes: `session_id` missing or set to the retired value `__global__`, an unknown `thought_type`, `recommended_tool` written in the singular, a number below 1.

**JSON with `code`, `error`, `message` and `status: "failed"`.** The input was well formed but the server refused it.

| `code`                                       | Message contains                                                                   | Fix                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                           | `requires verification_target`, `verification_target N is missing`, `is ambiguous` | A `verification` with a result must name an existing thought number that was used once                                                                |
| `VALIDATION_ERROR`                           | `verification_target must have confidence`                                         | The target has no `confidence`. Send a revision of it that carries `confidence` and verify the number of that revision, or drop `verification_result` |
| `VALIDATION_ERROR`                           | `already has a recorded result`                                                    | A target takes one result. Do not resend. If you changed your mind, revise or backtrack the hypothesis                                                |
| `VALIDATION_ERROR`                           | `requires backtrack_target`                                                        | Add `backtrack_target`                                                                                                                                |
| `INVALID_BACKTRACK`                          | `must be <=`, `does not exist`, `is ambiguous`                                     | Target an existing, unique, earlier thought                                                                                                           |
| `VALIDATION_ERROR`                           | `requires the ... feature flag`                                                    | That type is switched off on this server. Use the type the message suggests, or `regular`                                                             |
| `VALIDATION_ERROR`                           | `Thought id already exists`                                                        | Leave `id` out; the server generates it                                                                                                               |
| `VALIDATION_ERROR`                           | `missing continuation_token`                                                       | A `tool_observation` needs the token from its `tool_call`                                                                                             |
| `INVALID_TOOL_CALL`                          | `missing required tool_name`                                                       | Add `tool_name`                                                                                                                                       |
| `UNKNOWN_TOOL`                               | `not registered with the server`                                                   | Record the tool run as ordinary thoughts                                                                                                              |
| `SUSPENSION_NOT_FOUND`, `SUSPENSION_EXPIRED` | `Suspension token not found`, `Suspension token expired`                           | The token was used, belongs to another session, or expired. Record the result as a `regular` thought                                                  |
| `SESSION_EXPIRED`                            | `has expired`                                                                      | New `session_id`, or `reset_state: true` on thought 1                                                                                                 |
| `SESSION_ACCESS_DENIED`                      | `Access denied to session`                                                         | The id belongs to another client. Choose a different `session_id`                                                                                     |

## Operational errors

These say nothing about your input.

- `LOCK_TIMEOUT`, `PERSISTENCE_BACKLOG_FULL`: wait and resend the same call.
- `MAX_SESSIONS_REACHED`: the server holds its maximum of live sessions. A different `session_id` hits the same limit, so wait and resend.
- `SESSION_LIFECYCLE_CLOSED`: the message names a phase. The session phases concern this session only:
  - `resetting` and `evicting` pass on their own: retry once, then continue under a new `session_id`.
  - `eviction_failed` and `reset_failed` stay closed until the session is recovered. Continue under a new `session_id` with a thought that restates what was established, or restart the same id with `reset_state: true` on thought 1, which deletes its chain. A session in `eviction_failed` that the server later finishes evicting answers `SESSION_EXPIRED` instead.
  - `shutting_down` and `stopped` mean the whole server is going away and no id will work.

After two failed retries, stop calling the tool. Finish the reasoning without it and tell the user the thinking server was unavailable.
