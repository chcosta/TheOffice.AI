---
name: detect-waittime-alerts
description: Compute current and prior queue wait-time statistics and identify offending queues.
---

# Detect Wait-Time Alerts

Compute wait-time statistics for the current and prior windows and identify queues that should be included in the alert.

## Inputs

- `environment`: `staging` or `production`
- `queues[]`: active queue names discovered by `discover-active-queues`
- `freshnessThresholdMinutes`: default `45`

## Query Plan

Use deterministic, ingestion-anchored KQL.

1) Determine the latest ingested event time (`analysisEnd`) from `WorkItems.Started`.

2) Compute queue wait metrics using windows relative to `analysisEnd`:
- current: `[analysisEnd - 30m, analysisEnd]`
- prior: `[analysisEnd - 90m, analysisEnd - 30m)`

3) Compute freshness lag: `ingestionLagMinutes = now() - analysisEnd`.

```kql
let analysisEnd = toscalar(
  WorkItems
  | where Attempt == 1
  | where FriendlyName !startswith "Orchestration"
  | where FriendlyName !startswith "HelixController"
  | summarize max(Started)
);
let currentStart = analysisEnd - 30m;
let priorStart = analysisEnd - 90m;
Jobs
| where Started between (priorStart .. analysisEnd)
| project QueueName, JobName = Name
| join kind = inner (
    WorkItems
    | where Attempt == 1
    | where FriendlyName !startswith "Orchestration"
    | where FriendlyName !startswith "HelixController"
    | project JobName = JobName, WorkItemQueued = Queued, WorkItemStarted = Started, WorkItemFinished = Finished
    | extend WaitMinutes = todouble(WorkItemStarted - WorkItemQueued) / 1m
) on JobName
| where WorkItemStarted between (priorStart .. analysisEnd)
| extend Window = iff(WorkItemStarted >= currentStart, "current", "prior")
| summarize
    WorkItemCount = count(),
    MaxWaitMinutes = max(WaitMinutes),
    P95WaitMinutes = percentile(WaitMinutes, 95),
    AvgWaitMinutes = avg(WaitMinutes),
    Over60Count = countif(WaitMinutes > 60),
    NearThresholdCount = countif(WaitMinutes between (45 .. 60))
  by QueueName, Window
| order by QueueName asc, Window asc
```

```kql
let analysisEnd = toscalar(
    WorkItems
    | where Attempt == 1
    | where FriendlyName !startswith "Orchestration"
    | where FriendlyName !startswith "HelixController"
    | summarize max(Started)
);
print AnalysisEndUtc = analysisEnd, IngestionLagMinutes = datetime_diff('minute', now(), analysisEnd)
```

## Classification

Classify each queue using the current window result and compare it to the prior window:

- `offending` if current `MaxWaitMinutes > 60`
- `watch` if current `MaxWaitMinutes` is between `45` and `60` and the trend is rising
- `recovered` if current `MaxWaitMinutes <= 60` and the prior window was over 60
- `healthy` otherwise

Ingestion health:

- `ingestionHealthy` when `ingestionLagMinutes <= freshnessThresholdMinutes`
- `ingestionFault` when `ingestionLagMinutes > freshnessThresholdMinutes`

`ingestionFault` is alert-worthy even when `offendingQueues[]` is empty.

Trend labels:
- `new breach` when current is over 60 and prior is not
- `sustained breach` when both current and prior are over 60
- `rising` when current is below threshold but materially above prior
- `falling` when current is below prior

## Output

Return a structure with:
- `activeQueues`
- `currentWindow`
- `priorWindow`
- `analysisEndUtc`
- `ingestionLagMinutes`
- `ingestionHealthy`
- `ingestionFault`
- `queueSummaries[]` with current and prior wait stats, trend, and classification
- `offendingQueues[]`
- `watchQueues[]`
- `recoveredQueues[]`

## Notes

- Current wait time is the alert driver.
- Do not alert on depth alone.
- If the telemetry query fails, note the failure and return an empty offending list rather than fabricating results.
- Do not treat missing current-window samples as healthy unless ingestion is confirmed healthy.