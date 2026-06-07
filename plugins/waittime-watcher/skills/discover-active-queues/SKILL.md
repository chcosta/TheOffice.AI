---
name: discover-active-queues
description: Discover active Helix queues from engineeringdata Jobs rows.
---

# Discover Active Queues

Use the `Jobs` table in `engineeringdata` to discover the active queue set.

This step is queue-name discovery only. Do not compute per-queue job counts here.

## Query

Run this Kusto query against the selected environment's telemetry server:

```kql
Jobs
| where Started >= ago(90m)
| where isnotempty(QueueName)
| distinct QueueName
| order by QueueName asc
```

## Output

Return:
- `queues`: string array of active queue names
- `count`: number of active queues (computed from the returned distinct list)

## Notes

- Use a short lookback for discovery to keep this query fast.
- Do not infer activity from depth alone; only queues with recent jobs count as active.
- If a longer horizon is needed for diagnostics, run a separate follow-up query after discovery.