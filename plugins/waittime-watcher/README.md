# WaitTime Watcher — Copilot CLI Plugin

A Copilot CLI plugin that watches Helix queue wait times from the `engineeringdata` Kusto database and alerts only when an active queue exceeds 60 minutes of observed wait time.

## Installation

```bash
copilot plugin install .github/plugin/waittime-watcher
copilot plugin list
```

## Usage

```
# Staging scan
@waittime-watcher /prompt staging-waittime-watcher

# Production scan
@waittime-watcher /prompt production-waittime-watcher

# Free-form invocation
@waittime-watcher Check production queue wait times and alert me only if any active queue is over 60 minutes.
```

## What It Does

- Discovers active queues from `Jobs` in `engineeringdata`.
- Joins `Jobs` to `WorkItems` to compute queue wait time from `Queued` to `Started`.
- Compares the current 30-minute window to the prior 30-90 minute window.
- Alerts only for queues whose observed wait time exceeds 60 minutes.
- Suppresses notifications entirely when no queue is over the threshold.

## Plugin Structure

```
.github/plugin/waittime-watcher/
├── plugin.json
├── .mcp.json
├── dotnet-tools.json
├── nuget.config
├── README.md
├── agents/
└── skills/
```

## Notification Contract

The plugin is designed to pair with a Teams notification layer that posts Markdown only.

- Default webhook secret: `HelixQueueNotifications`
- Default vault: `ScriptedAgentsKVRing1`
- Notification rule: do not send anything when no active queue exceeds 60 minutes

The actual Teams post should be a concise Markdown alert with:
- Environment and scan window
- Number of active queues scanned
- Number of offending queues
- A table of offending queues with current wait, prior wait, and trend
- Optional notes for near-threshold queues

## Kusto Targets

- Staging: `https://engdata.westus2.kusto.windows.net` / `engineeringdata`
- Production: `https://engsrvprod.kusto.windows.net` / `engineeringdata`

## Notes

This plugin is intentionally narrower than the queue-health plugins. It focuses on wait-time SLO breaches and leaves work-item filing and broader autoscaler health to the existing plugins.