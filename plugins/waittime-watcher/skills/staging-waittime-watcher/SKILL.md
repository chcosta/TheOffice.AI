---
name: staging-waittime-watcher
description: Run the wait-time watcher against staging engineeringdata.
---

# Staging WaitTime Watcher

Use the staging telemetry target:

- Cluster: `https://engdata.westus2.kusto.windows.net`
- Database: `engineeringdata`

Use the `waittime-watcher-staging-thrive` MCP server for Kusto queries.

Run `discover-active-queues` first, then `detect-waittime-alerts`, then apply the `send-waittime-notification` contract only if there are offending queues.

Suppress notification when no queue exceeds 60 minutes.