# Cognilode Slack MCP

This is a fork of **korotovsky/slack-mcp-server**, not a replacement Slack API implementation. The upstream server was deployed and installed as the private ChatGPT app **Cognilode Slack — Unofficial MCP** before these extensions were authored. The same provider session, caches, Go Slack client and MCP transport serve the extended tools.

## Working interface

- `conversations_read`: complete readable Markdown for a channel page, a thread page or search results. Bodies are not shortened; source identities, attachments and continuation cursors remain available. A channel page is not the full channel plus all its threads. Follow cursors and read relevant replies. Upstream history/replies also retain a cursor when an activity-only page is filtered out.
- `conversations_manage`: native channel info/create/rename/archive/unarchive/topic/purpose. Changes update only the affected upstream cache entry. Slack administration does not automatically redefine a Company Project or Employee.
- `conversations_edit_message`: update an existing message using the upstream client.
- `conversations_curate`: apply the managing agent's semantic review, retaining valuable content, deleting low-value messages and redundant copies, and publishing useful synthesis first when selected. Reasons are substantive judgments, not length, keyword or duplicate-only classifiers. Up to twenty reviewed decisions per call, paced mutations, explicit partial results. No extra D1 Slack corpus. Unknown outcomes are not automatically replayed.
- Existing **Unified Projects** MCP tools are discovered from their owning API and exposed through this server. UUIDs, aliases, Project lifecycle and provider bindings stay in that API. Its native ChatGPT/Slack mirror operations may report unavailable adapters; installing this app does not by itself complete those domain integrations.
- `taskflow_read`, `taskflow_update`: consume existing native plans/revisions and submit native plan revisions or step signals through TaskFlow's actual API. No new planner, queue or copied plan database.
- `taskflow_publish`: publish/update a readable outline of an actual native plan with its current revision/progress and a link to the full plan. Use the returned message ID on subsequent updates. Large outlines fail explicitly rather than silently lose steps.
- `taskflow_update_from_slack`: read a specific Slack change message, apply the agent-reviewed native payload through TaskFlow's expected-revision contract, and acknowledge the accepted revision in the same message. Native acceptance and Slack publication failures remain separate. This is explicit tool-driven synchronization; it is not a claim of an installed background two-way synchronization daemon.

## Practical use

Read actual context before deciding what matters. Temporary claims and unchanged check-ins usually lose value quickly. Important discoveries, original requirements, corrections, useful reports and returned work merit careful retention or synthesis. For redundant cross-posts, identify the useful retained copy in the deletion reason. Do not infer human authorship or authority from the shared Slack account.

Project channels, team communication, skills and durable professional roles are different things. Do not mass-rename them to resemble tool modules. Make organizational changes only after understanding the work and the owner's intent.

The installed app retains upstream unread, marking, search, user-group and posting tools. Use it for real reading, writing, selective cleanup and plan coordination, and consume the returned results.

## Hosting

One dedicated Cloudflare lite container, pinned upstream base image plus the CI-built fork binary. The Worker handles authentication, central credential injection, startup and transport only; Slack operations are in this upstream fork. The existing encrypted credential service owns the Slack session and the app access credential. No provider credentials belong in this repository or Slack messages.

The GitHub workflow tests complete multiline source preservation and builds the real upstream executable. Container image changes require a native Cloudflare image **rollout**, not just a Worker release or application PATCH. Verify the server version/tool catalog, then refresh the installed app. A successful upload is not a successful runtime upgrade.
