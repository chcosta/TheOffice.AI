---
name: parse-rotations
description: Fetches and parses the FR-Ops-Rotation wiki to determine current rotation assignments
---

## Parse Rotations

Fetch the FR-Ops-Rotation wiki and extract current rotation assignments.

### Step 1: Fetch the Wiki

Use `get_file` to retrieve the rotation wiki:
- **Organization:** dnceng
- **Project:** internal
- **Repository:** dotnet-eng-wiki
- **Path:** /FR-Ops-Rotation.md
- **Branch:** wikiMaster

### Step 2: Parse Rotation Schedule

Analyze the wiki content to find rotation entries that include today's date.

Look for:
- Rotation tables or schedule sections
- Entries with date ranges that encompass today
- Common rotation types: FR (First Responder), Ops, On-Call

### Step 3: Return Results

For each active rotation, extract:
- **Rotation type** (FR, Ops, On-Call, etc.)
- **Person currently on rotation** (name and alias)
- **Start date** of their rotation period
- **End date** of their rotation period

Include the wiki source URL so the agent can link back to it:
- `[FR-Ops-Rotation Wiki](https://dev.azure.com/dnceng/internal/_git/dotnet-eng-wiki?path=/FR%252DOps-Rotation.md)`

If the wiki format is unrecognizable or no rotations match today's date, report what was found, note any parsing issues, and include the wiki link so the reader can check manually.
