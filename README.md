# Copilot Agent Supervisor

A local service that manages and schedules Copilot CLI agent sessions with a web dashboard.

## Quick Start

```bash
cd C:\repos\sessions
npm install
npm start
```

Dashboard: http://localhost:3847

## Features

- **Rich scheduling** — simple intervals (`30m`, `1h`), human-readable (`weekdays at 9am`), or cron expressions
- **Web dashboard** — view status, last results, errors, start/stop agents, change schedules
- **Durable agents** — marked agents always restart on service boot and retry on failure
- **Error visibility** — stderr displayed in red, auto-expanded on errors
- **Run history** — SQLite-backed log of all executions with output capture
- **REST API** — full programmatic control
- **VS Code integration** — button to open project in VS Code Insiders

## Install as Windows Scheduled Task (survives reboots/sleep)

Run from an **elevated (admin)** terminal:

```bash
npm run install-service
```

This creates a Windows Scheduled Task with:
- **Logon trigger** — starts when you sign in
- **5-minute watchdog** — restarts the service if it dies (sleep, crash, etc.)
- **`MultipleInstances=IgnoreNew`** — prevents duplicate processes

To remove:
```bash
npm run uninstall-service
```

## Configuration

Edit `agents.json` to add/remove agents:

```json
{
  "id": "my-agent",
  "name": "My Agent Display Name",
  "cwd": "C:\\repos\\my-repo",
  "agent": "Agent Display Name",
  "schedule": "weekdays at 9am",
  "prompt": "do the thing",
  "durable": true,
  "copilotPath": "C:\\Users\\you\\AppData\\Roaming\\npm\\copilot.cmd",
  "triggers": {
    "onSuccess": ["other-agent-id"],
    "onFailure": ["alert-agent-id"]
  }
}
```

### Conditional triggers

Agents can trigger other agents based on their exit status:

```json
"triggers": {
  "onSuccess": ["deploy-agent"],
  "onFailure": ["alert-agent", "rollback-agent"],
  "onComplete": ["cleanup-agent"]
}
```

| Trigger | Fires when |
|---------|------------|
| `onSuccess` | Agent exits with code 0 |
| `onFailure` | Agent exits with non-zero code |
| `onComplete` | Agent finishes regardless of exit code |

Each trigger value can be a single agent ID string or an array. Triggers are displayed in the dashboard with colored badges (green for success, red for failure, blue for complete).
```

### Schedule formats

| Format | Example | Description |
|--------|---------|-------------|
| Simple interval | `30m`, `1h`, `2h` | Cron-aligned to clock boundaries |
| Human-readable | `every hour at :30` | At 30 minutes past each hour |
| Day schedule | `weekdays at 7am and 9pm` | Mon-Fri at 7am and 9pm |
| Day list | `M,T,W,Th,F at 9am` | Specific days |
| Every N | `every 15 minutes` | Every 15 minutes |
| Cron expression | `0 7,21 * * 1-5` | Standard 5-field cron |

### Agent config fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `name` | Yes | Display name in dashboard |
| `cwd` | Yes | Working directory for copilot CLI |
| `agent` | Yes | Agent name (as shown in `copilot --help` or agent list) |
| `schedule` | Yes | Schedule expression (see formats above) |
| `prompt` | Yes | Prompt text sent to the agent each run |
| `durable` | No | If `true`, always starts on boot regardless of DB state |
| `copilotPath` | No | Full path to `copilot.cmd` (auto-resolved if omitted) |
| `allowAll` | No | If `false`, omits `--yolo` flag (default: `true`) |
| `triggers` | No | Conditional triggers: `{ onSuccess, onFailure, onComplete }` |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents with status |
| GET | `/api/agents/:id` | Get single agent status |
| GET | `/api/agents/:id/history` | Get run history |
| POST | `/api/agents/:id/start` | Start scheduled agent |
| POST | `/api/agents/:id/stop` | Stop agent |
| POST | `/api/agents/:id/run` | Trigger immediate run |
| PUT | `/api/agents/:id/schedule` | Update schedule (persists to `agents.json`) |
| PUT | `/api/agents/:id/triggers` | Update triggers (persists to `agents.json`) |
| POST | `/api/agents` | Add new agent (JSON body) |
| DELETE | `/api/agents/:id` | Remove agent |
| POST | `/api/reload` | Reload agents.json |
| POST | `/api/schedule/describe` | Describe a schedule string |
| POST | `/api/open-editor` | Open project in VS Code Insiders |
