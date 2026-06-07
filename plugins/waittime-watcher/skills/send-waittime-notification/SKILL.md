---
name: send-waittime-notification
description: Teams-formatted notification contract for wait-time breaches.
---

# Send Wait-Time Notification

This skill defines the Markdown contract for posting queue wait-time alerts to Teams.

## Inputs

- `environment`
- `activeQueueCount`
- `offendingQueues[]`
- `watchQueues[]` (optional)
- `currentWindow`
- `priorWindow`
- `analysisEndUtc`
- `ingestionLagMinutes`
- `ingestionFault`

## Notification Rule

- If `offendingQueues[]` is empty and `ingestionFault == false`, do not send a notification.
- If at least one offending queue exists OR `ingestionFault == true`, post one concise Teams message in Markdown only.

## Teams Rendering Rules

- No HTML tags.
- No outer code fences.
- Use bold for queue names.
- Use plain Markdown tables.
- Keep the body compact and operational.

## Recommended Message Shape

```markdown
## Wait Time Alert Summary

Environment: `{environment}`
Scan window: `{currentWindow}` vs `{priorWindow}`
Analysis end (ingested): `{analysisEndUtc}`
Ingestion lag: `{ingestionLagMinutes}m`
Active queues scanned: `{activeQueueCount}`
Offending queues: `{offendingQueues.length}`

### Data Freshness

- `ingestion-fault` when lag exceeds threshold: `{ingestionFault}`

### Offending Queues

| Queue | Current Max | Prior Max | Trend | Jobs | Summary |
| --- | --- | --- | --- | --- | --- |
| **`queue-name`** | `72m` | `18m` | `new breach` | `31` | Wait time crossed the 60 minute threshold. |

### Watch List

- `queue-name` — current max `48m`, rising versus the prior window.

### Notes

- `new breach` means the queue crossed the threshold in the current window.
- `sustained breach` means the queue was already over threshold in the prior window too.

### Legend

- `offending` = current max wait above 60 minutes
- `watch` = near threshold and rising
- `recovered` = prior breach cleared in the current window
```

## Suppression

Suppress only when BOTH are true:
- no queues exceed 60 minutes, and
- ingestion is healthy (`ingestionFault == false`).