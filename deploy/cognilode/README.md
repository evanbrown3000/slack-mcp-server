# Cognilode Slack capability

This directory owns the free-tier native Slack upstream and Company Project adapter.
The ordinary Worker uses `native/`; the old Container entry is in Git history, not the current default.

These exact implementation modules were promoted from the stronger Operator deployment source.
They preserve native message/thread reads, pagination, workspace/channel identity, files,
verified mutating effects and Company project binding. No second event store, queue or sender.

Important: `slack_project_archive` is an archival operation, **not permanent deletion**.
Slack's documented `admin.conversations.delete` is Enterprise-only. Slack Free Workspace
Owners/Admins permanently delete channels through Slack's normal Settings UI.
A future assisted delete operation must use the authorized native administrative UI,
with exact channel identity and readback, not mislabel an archive.

After provider cutover/readback, Operator Panel historical source copies can be retired.
Do not infer production selection merely from this source publication.
