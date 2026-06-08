---
name: resolve-notification-target
description: Resolves vault and secret names from natural language requests for Teams webhook notifications
---

## Resolve Notification Target

Map user phrasing to a `(vaultName, secretName)` target for Teams webhook notification.

### Normalization Rules

- Treat these as equivalent vault names:
  - `scriptedagentskvring1`
  - `ScriptedAgentsKVRing1`
  - `ScripedAgentsKVRing1` (common typo)
- Treat these as equivalent secret naming styles:
  - exact secret name, for example `AgentWorkflowOperationsTeamsChannel`
  - URI-style secret reference, for example
    `https://scriptedagentskvring1.vault.azure.net/secrets/AgentWorkflowOperationsTeamsChannel/<version>`

### Extraction Rules

1. If the prompt includes a full Key Vault secret URI, parse vault and secret from that URI.
2. Otherwise, read `<secretName> in <vaultName>` from natural language.
3. If vault is omitted, ask a single clarifying question unless there is exactly one obvious default in context.
4. If secret is omitted, ask a single clarifying question.

### Safety Rules

- Never print or echo webhook values.
- Never include raw secret content in the final response.
- When reporting action, reference only vault and secret names.
