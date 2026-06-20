---
name: board-tools
description: Read and update TheOffice.AI boards (pins, notes, checklists) via the board MCP tools. Use when the user asks you to look at a board, summarize what's pinned, add notes or checklists, check items off, or pin a resource to a board.
---

# Board Tools

You have access to the **board** MCP server, which lets you read and update
TheOffice.AI boards. A board is a curated workspace that holds:

- **pins** — resources (agents, managers, tasks, assignments, flows, chats, CLI
  sessions) shown as panels,
- **notes** — free-text markdown notes,
- **checklists** — titled lists of items, each of which can be checked off and
  can optionally link to a pinned resource.

## Tools

| Tool | What it does |
| --- | --- |
| `list_boards` | List every board with id, name, emoji, scope, and counts. **Start here** to find a `boardId`. |
| `get_board` | Read one board's full contents — pins, notes, and checklists with item ids and done state. |
| `add_note` | Add a markdown note to a board. |
| `add_checklist` | Create a checklist, optionally pre-filled with items. |
| `add_checklist_items` | Append items to an existing checklist. |
| `set_checklist_item` | Mark a checklist item done / not-done. |
| `pin_to_board` | Pin a resource (by kind + refId) so it appears as a panel. |

## How to use them

1. Call `list_boards` to discover the board the user means, then `get_board` to
   read its current state before changing anything.
2. When adding to or checking off a checklist, use the **ids returned by
   `get_board`** (`checklistId`, item `id`) — never guess ids.
3. Checklist items may carry a `ref` linking them to a pinned resource:
   `{ text, ref: { kind, refId, label } }`. Only set a `ref` whose `kind`+`refId`
   matches a resource already pinned to that board (see the board's `pins`).
4. Valid pin/ref `kind`s: `agent`, `manager`, `task`, `assignment`, `flow`,
   `chat`, `session`, `location`. For tasks the `refId` is typically
   `task-<id>`.
5. Prefer making the smallest change that satisfies the request. Read back with
   `get_board` if you need to confirm the result.

## Examples

- *"What's on my Autoscaler board?"* → `list_boards` → `get_board` → summarize
  the pins, notes, and open checklist items.
- *"Add a checklist for the incident with three steps."* →
  `add_checklist(boardId, "Incident", ["Triage", "Mitigate", "Write-up"])`.
- *"Mark the triage step done."* → `get_board` to find the item id →
  `set_checklist_item(boardId, checklistId, itemId, true)`.
- *"Pin the email-sender agent here."* →
  `pin_to_board(boardId, "agent", "email-sender", "Email Sender")`.
