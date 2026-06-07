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

- **Scheduled execution** — agents run on configurable intervals (e.g., `1h`, `30m`, `2h`)
- **Web dashboard** — view status, last results, start/stop agents, change schedules
- **Durable agents** — marked agents auto-retry on next cycle after failure
- **Run history** — SQLite-backed log of all executions with output capture
- **REST API** — full programmatic control

## Install as Windows Service (survives reboots)

```bash
npm run install-service
```

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
  "agent": "agent-name:agent-config",
  "schedule": "1h",
  "prompt": "do the thing",
  "durable": true
}
```

Schedule format: `<number><unit>` where unit is `s`, `m`, `h`, or `d`.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents with status |
| GET | `/api/agents/:id` | Get single agent status |
| GET | `/api/agents/:id/history` | Get run history |
| POST | `/api/agents/:id/start` | Start scheduled agent |
| POST | `/api/agents/:id/stop` | Stop agent |
| POST | `/api/agents/:id/run` | Trigger immediate run |
| PUT | `/api/agents/:id/schedule` | Update schedule (`{"schedule":"30m"}`) |
| POST | `/api/agents` | Add new agent (JSON body) |
| DELETE | `/api/agents/:id` | Remove agent |
| POST | `/api/reload` | Reload agents.json |
