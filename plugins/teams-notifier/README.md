# teams-notifier plugin

Purpose: send Teams notifications where the webhook URL is stored as a secret in Azure Key Vault.

## Included behavior

- Direct send mode
- Analyze-and-decide mode (send only when alerting is warranted)
- Vault/secret extraction from natural language and Key Vault secret URI
- Common typo normalization for `ScripedAgentsKVRing1`

## Use from AgencyX

```csharp
var result = await AgencyX.ExecuteAsync(
    AgencyX.CreateCommand()
        .WithMarketplace("dnceng/internal:dnceng-agent-workflows@main")
        .WithPlugin("local:./.github/plugin/teams-notifier")
        .WithPrompt("Send this message to the AgentWorkflowOperationsTeamsChannel in ScriptedAgentsKVRing1: Build 1234 failed due to timeout.")
        .Build());
```

## Example prompts

- `Send this message to the AgentWorkflowOperationsTeamsChannel in ScriptedAgentsKVRing1: Build failed in production ring.`
- `Analyze this report and determine if we should alert by sending a notification to AgentWorkflowOperationsTeamsChannel in ScriptedAgentsKVRing1, if not, do nothing.`
- `Send this to https://scriptedagentskvring1.vault.azure.net/secrets/AgentWorkflowOperationsTeamsChannel/<version>: Service health degraded.`

## Notes

- This plugin never prints raw webhook URLs.
- If target resolution is ambiguous, the agent asks one concise clarification question.
