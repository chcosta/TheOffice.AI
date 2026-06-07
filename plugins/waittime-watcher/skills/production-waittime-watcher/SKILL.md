---
name: production-waittime-watcher
description: Run the wait-time watcher against production engineeringdata.
---

# Production WaitTime Watcher

Use the production telemetry target:

- Cluster: `https://engsrvprod.kusto.windows.net`
- Database: `engineeringdata`

Use the `waittime-watcher-production-thrive` MCP server for Kusto queries.

Run `discover-active-queues` first, then `detect-waittime-alerts`, then apply the `send-waittime-notification` contract only if there are offending queues.

Suppress notification when no queue exceeds 60 minutes.