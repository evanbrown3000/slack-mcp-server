# Autonomous Slack conversation segments and canonical sync cutover

This increment extends the existing Cognilode Slack MCP owner. It is not a second
Slack daemon, corpus, project registry, TaskFlow, sender, or model client.

## Permanent design

- Slack remains the native message/channel owner.
- `generic_llm/llm.completion()` is the shared selectable-model completion
  boundary. This server calls its MCP adapter via `COGNILODE_COMPLETION_MCP_URL`;
  model, reasoning effort and prompt profile are explicit.
- Unified Projects remains the Project authority. Every automatic cycle first
  invokes its existing reconciliation/read operations and only processes exact
  active Slack channel IDs returned by that owner.
- TaskFlow remains the plan/execution authority; the already-existing automatic
  TaskFlow-to-Slack mirror remains active.
- A conversation-segment summary is source-bound to the exact Slack channel,
  first/last message IDs and SHA-256. That marker is the restart cursor: no KV,
  D1, local snapshot database or duplicate transcript store is introduced.
- The model decides whether a semantic segment exists. Message length, keywords
  and exact-equality heuristics are not used as semantic substitutes.
- The summary is published and read back exactly before any original deletion.
  Only explicit model-selected ordinary messages can be deleted, and each is
  reread with exact text before deletion. Threads, files and attachments remain.
- Automatic scanning is limited to canonical active channels. Request/page counts
  are returned as resource cost. Limited quota is treated as cost, not only USD.
- Project/Employee channel lifecycle deletion is deliberately not inferred from
  names. Destructive lifecycle reconciliation requires the authoritative complete
  Project/Employee source and a provider operation that truly deletes rather than
  merely archives. Missing Company/Employee authority is not converted to a
  delete decision.

## Host cutover

The source is host-neutral Go and supports stdio/SSE/streamable HTTP. The current
Cloudflare lite Container deployment is not an acceptable post-Free permanent
host. Activate this same full server on the selected permanent native B4PT0R host
with the existing Slack credentials and native owner URLs. Do not replace it with
a reduced Worker implementation.

Required runtime configuration:

- `COGNILODE_OPERATOR_TOKEN`
- existing Slack session/token variables
- `COGNILODE_PROJECTS_MCP_URL`
- `COGNILODE_TASKFLOW_URL`
- `COGNILODE_COMPLETION_MCP_URL`
- `COGNILODE_SLACK_AUTONOMY=1`
- `COGNILODE_SLACK_SUMMARY_MODEL`
- `COGNILODE_SLACK_SUMMARY_REASONING`
- `COGNILODE_SLACK_SUMMARY_PROFILE`

The default autonomous interval is three minutes; that is an operational cadence,
not semantic classification. The LLM decides whether the current source is a
coherent segment. Operators can invoke `conversations_segment_run` or
`conversations_autonomy_now` for immediate work.

## Slack deletion capability

Ordinary Slack conversation APIs can archive channels but cannot permanently
delete arbitrary workspace channels. Slack's official
`admin.conversations.delete` / bulk-delete capabilities require the applicable
admin/plan authority. The system must probe/use that native provider capability
when available. It must never relabel archive as delete. Project deletion already
uses the existing Unified Projects operation that owns both native mirrors.

Source publication is not a claim that the permanent native host is selected,
that the model returned a summary, or that Slack accepted a deletion.
