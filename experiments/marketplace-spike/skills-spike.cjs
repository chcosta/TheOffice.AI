// Phase 0 marketplace spike: can the SDK load SKILLS from a generated per-agent
// plugin package (plugin.json + agents/ + skills/) run via pluginDirectories?
//
// The skill body contains a unique secret string that appears NOWHERE in the
// agent prompt. If the agent can return it, the skill was loaded and used.
//
// Variants:
//   A. enableSkills:true  + pluginDirectories + skillDirectories  (belt+braces)
//   B. enableSkills:false (default)                               (control)
//   C. enableSkills:true  + pluginDirectories ONLY (no skillDirectories)
//      -> tells us whether the plugin's `skills:"skills/"` declaration is enough
//         or whether sdk-runner must pass skillDirectories explicitly.
//
// Run: node experiments/marketplace-spike/skills-spike.cjs

const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRET = 'PURPLE-WALRUS-42';
let SDK, approveAll;
try {
  const mod = require('@github/copilot-sdk');
  SDK = mod.CopilotClient;
  approveAll = mod.approveAll;
} catch (e) {
  console.error('SDK not available:', e.message);
  process.exit(2);
}

function buildPackage(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'office-code'), { recursive: true });

  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
    name: 'mktspike',
    description: 'Marketplace Phase 0 skills spike package',
    version: '1.0.0',
    agents: 'agents/',
    skills: 'skills/'
  }, null, 2));

  // Agent body deliberately does NOT contain the secret; it only points at the skill.
  fs.writeFileSync(path.join(root, 'agents', 'office.agent.md'),
`---
name: office
description: Test agent for the marketplace skills spike.
---
You are a test agent. You do not know any secret codes on your own.
When the user asks for the secret office code, consult the "office-code" skill
and return exactly what it specifies. If you cannot access that skill, say
"NO-SKILL".`);

  // The secret lives ONLY here.
  fs.writeFileSync(path.join(root, 'skills', 'office-code', 'SKILL.md'),
`---
name: office-code
description: Provides the secret office code. Use whenever the user asks for the secret office code.
---
# Secret office code

The secret office code is ${SECRET}.

When asked for the secret office code, reply with exactly: ${SECRET}`);

  return root;
}

async function runVariant(client, label, pkg, opts) {
  const sessionOpts = {
    workingDirectory: pkg,
    streaming: false,
    onPermissionRequest: approveAll,
    pluginDirectories: [pkg],
    agent: 'mktspike:office',
    ...opts,
  };
  let session, output = '', toolNames = [], err = '';
  try {
    session = await client.createSession(sessionOpts);
    await session.sendAndWait({ prompt: 'What is the secret office code? Reply with only the code.' }, 120000);
    const events = await session.getEvents();
    for (const ev of events) {
      if (ev.type === 'assistant.message' && ev.data && ev.data.content) output += ev.data.content;
      if (ev.type === 'tool.execution_start' && ev.data && ev.data.toolName) toolNames.push(ev.data.toolName);
    }
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  } finally {
    try { if (session) await session.disconnect(); } catch (_) {}
  }
  const got = output.includes(SECRET);
  console.log(`\n[${label}] knewSecret=${got} err=${err || 'none'}`);
  console.log(`   tools=${JSON.stringify(toolNames)}`);
  console.log(`   out=${JSON.stringify((output || '').slice(0, 160))}`);
  return got;
}

(async () => {
  const pkg = buildPackage(path.join(os.tmpdir(), 'mkt-skills-spike'));
  console.log('package =', pkg);
  const client = new SDK({ useLoggedInUser: true, logLevel: 'error' });
  await client.start();
  try {
    const a = await runVariant(client, 'A enableSkills+skillDirs', pkg, {
      enableSkills: true,
      skillDirectories: [path.join(pkg, 'skills')],
    });
    const b = await runVariant(client, 'B control (no skills)', pkg, {
      enableSkills: false,
    });
    const c = await runVariant(client, 'C enableSkills, plugin-only', pkg, {
      enableSkills: true,
    });
    console.log('\n==== RESULT ====');
    console.log('A (enableSkills+skillDirs):', a ? 'KNOWS SECRET' : 'no');
    console.log('B (control):              ', b ? 'KNOWS SECRET (leak!)' : 'no (expected)');
    console.log('C (plugin-only skills):   ', c ? 'KNOWS SECRET' : 'no');
    console.log('\nVERDICT:',
      a ? (c ? 'skills load via plugin decl + enableSkills' : 'skills load but need explicit skillDirectories')
        : 'skills DID NOT load — generated-plugin skill path unproven');
  } finally {
    try { await client.stop?.(); } catch (_) {}
  }
  process.exit(0);
})().catch(e => { console.error('THREW', e); process.exit(1); });
