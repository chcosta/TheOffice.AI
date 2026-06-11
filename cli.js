#!/usr/bin/env node
'use strict';

/**
 * Event Listener CLI — sends messages to Service Bus and receives replies.
 * Used for validating the full E2E event listener flow.
 * 
 * Usage:
 *   node cli.js                     # Interactive REPL mode
 *   node cli.js --send "@markbot what is team health"
 *   node cli.js --help
 * 
 * Environment:
 *   EVENT_SB_CONNECTION_STRING  — Service Bus connection string
 *   EVENT_INBOUND_QUEUE         — Inbound queue name (default: inbound-commands)
 *   EVENT_REPLY_QUEUE           — Reply queue name (default: outbound-replies)
 *   EVENT_SENDER_ID             — Your sender ID (default: cli-user)
 */

const { ServiceBusClient } = require('@azure/service-bus');
const readline = require('readline');
const crypto = require('crypto');
const http = require('http');

// Config from env or defaults
const CONNECTION_STRING = process.env.EVENT_SB_CONNECTION_STRING || '';
const INBOUND_QUEUE = process.env.EVENT_INBOUND_QUEUE || 'inbound-commands';
const REPLY_QUEUE = process.env.EVENT_REPLY_QUEUE || 'outbound-replies';
const SENDER_ID = process.env.EVENT_SENDER_ID || 'cli-user';
const LOCAL_URL = process.env.EVENT_LOCAL_URL || 'http://localhost:3847';

class EventCLI {
  constructor(options = {}) {
    this.localMode = options.local || false;
    this.localUrl = options.localUrl || LOCAL_URL;
    this.senderId = options.senderId || SENDER_ID;
    this.client = null;
    this.sender = null;
    this.receiver = null;
    this.pendingReplies = new Map();
    this.replyTimeout = 120000; // 2 minutes
  }

  async connect(connectionString) {
    if (this.localMode) {
      // Local mode — just verify the server is reachable
      try {
        const res = await this._httpGet(`${this.localUrl}/api/events/health`);
        const health = JSON.parse(res);
        console.log(`✅ Connected to local server (${this.localUrl})`);
        console.log(`   Connection state: ${health.connectionState}`);
        console.log(`   Sender ID: ${this.senderId}`);
        console.log('   Mode: LOCAL (bypasses Service Bus)');
        console.log('');
      } catch (err) {
        console.error(`❌ Cannot reach local server at ${this.localUrl}: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    const connStr = connectionString || CONNECTION_STRING;
    if (!connStr) {
      console.error('❌ No connection string. Set EVENT_SB_CONNECTION_STRING, pass --connection-string, or use --local');
      process.exit(1);
    }

    try {
      this.client = new ServiceBusClient(connStr);
      this.sender = this.client.createSender(INBOUND_QUEUE);
      this.receiver = this.client.createReceiver(REPLY_QUEUE);

      // Start listening for replies
      this.receiver.subscribe({
        processMessage: async (message) => {
          await this._handleReply(message);
        },
        processError: async (args) => {
          console.error(`⚠️  Reply queue error: ${args.error.message}`);
        }
      });

      console.log(`✅ Connected to Service Bus`);
      console.log(`   Inbound: ${INBOUND_QUEUE}`);
      console.log(`   Replies: ${REPLY_QUEUE}`);
      console.log(`   Sender:  ${SENDER_ID}`);
      console.log('');
    } catch (err) {
      console.error(`❌ Connection failed: ${err.message}`);
      process.exit(1);
    }
  }

  async _handleReply(message) {
    const body = message.body;
    const correlationId = message.correlationId || body?.correlationId;

    // Check if we're waiting for this reply
    const pending = this.pendingReplies.get(correlationId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingReplies.delete(correlationId);
      pending.resolve(body);
    } else {
      // Unsolicited reply — print it
      this._printReply(body);
    }
  }

  /**
   * Send a message and wait for reply
   */
  async send(content) {
    if (this.localMode) {
      return this._sendLocal(content);
    }
    return this._sendServiceBus(content);
  }

  async _sendLocal(content) {
    const correlationId = crypto.randomUUID();
    const body = JSON.stringify({
      senderId: this.senderId,
      correlationId,
      content
    });

    // Use streaming endpoint to show progress
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.localUrl}/api/events/simulate/stream`);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };

      const req = http.request(options, (res) => {
        let reply = null;
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.substring(7);
            } else if (line.startsWith('data: ') && currentEvent) {
              try {
                const data = JSON.parse(line.substring(6));
                if (currentEvent === 'step') {
                  this._printStep(data.step || data);
                } else if (currentEvent === 'reply') {
                  reply = data;
                } else if (currentEvent === 'status') {
                  // Initial status, ignore
                }
              } catch {}
              currentEvent = null;
            } else if (line === '') {
              currentEvent = null;
            }
          }
        });

        res.on('end', () => {
          resolve(reply || { status: 'error', error: 'No reply from server' });
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _printStep(step) {
    const icons = {
      thinking: '🤔',
      run_agent: '🚀',
      agent_result: '📋',
      complete: '✅',
      error: '❌',
      org_rejected: '🚫',
      request_agent: '📨'
    };
    const icon = icons[step.action] || '•';

    switch (step.action) {
      case 'thinking':
        process.stdout.write(`\r${icon} Step ${step.iteration}: Thinking...                    \n`);
        break;
      case 'run_agent':
        process.stdout.write(`\r${icon} Step ${step.iteration}: Running agent "${step.agentId}"...\n`);
        if (step.prompt) {
          const shortPrompt = step.prompt.length > 120 ? step.prompt.substring(0, 120) + '...' : step.prompt;
          process.stdout.write(`   Prompt: ${shortPrompt}\n`);
        }
        break;
      case 'agent_result':
        const status = step.exitCode === 0 ? 'succeeded' : `failed (exit ${step.exitCode})`;
        process.stdout.write(`\r${icon} Step ${step.iteration}: Agent "${step.agentId}" ${status} (${step.outputLength} bytes)\n`);
        break;
      case 'complete':
        // Don't print here — the final reply will be printed by _printReply
        break;
      case 'org_rejected':
        process.stdout.write(`\r${icon} Step ${step.iteration}: Agent "${step.agentId}" rejected (not in org)\n`);
        break;
      case 'error':
        process.stdout.write(`\r${icon} Step ${step.iteration}: Error: ${step.message}\n`);
        break;
      default:
        process.stdout.write(`\r${icon} Step ${step.iteration}: ${step.action}\n`);
    }
  }

  async _sendServiceBus(content) {
    const correlationId = crypto.randomUUID();

    const message = {
      body: {
        senderId: this.senderId,
        correlationId,
        content
      },
      correlationId,
      applicationProperties: { senderId: this.senderId }
    };

    await this.sender.sendMessages(message);

    // Wait for reply
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(correlationId);
        resolve({ status: 'timeout', content: '(no reply within timeout)' });
      }, this.replyTimeout);

      this.pendingReplies.set(correlationId, { resolve, timeout });
    });
  }

  // ─── HTTP helpers for local mode ──────────────────────────────────────────────

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  _httpPost(url, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _printReply(body) {
    if (!body) {
      console.log('📨 (empty reply)');
      return;
    }

    const status = body.status || 'unknown';
    const icon = status === 'complete' ? '✅' : status === 'error' ? '❌' : '📨';
    
    if (body.error) {
      console.log(`${icon} Error: ${body.error}`);
    } else if (body.content) {
      console.log(`${icon} ${body.content}`);
    } else {
      console.log(`${icon} ${JSON.stringify(body)}`);
    }
  }

  async startREPL() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `\n${SENDER_ID} > `
    });

    console.log('📡 Event Listener CLI — Interactive Mode');
    console.log('─────────────────────────────────────────');
    console.log('Commands:');
    console.log('  @name message   — Chat with agent/manager');
    console.log('  /run name       — Run a task/assignment');
    console.log('  /help           — List available assets');
    console.log('  /close          — Close active session');
    console.log('  /quit           — Exit CLI');
    console.log('─────────────────────────────────────────');

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) { rl.prompt(); return; }
      
      if (input === '/quit' || input === '/exit') {
        console.log('👋 Goodbye');
        await this.disconnect();
        process.exit(0);
      }

      try {
        const startTime = Date.now();
        process.stdout.write('⏳ Waiting for reply...');
        const reply = await this.send(input);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        this._printReply(reply);
        console.log(`\n⏱️  ${elapsed}s`);
      } catch (err) {
        console.error(`❌ Send failed: ${err.message}`);
      }

      rl.prompt();
    });

    rl.on('close', async () => {
      console.log('\n👋 Goodbye');
      await this.disconnect();
      process.exit(0);
    });
  }

  async disconnect() {
    // Clear pending replies
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timeout);
    }
    this.pendingReplies.clear();

    try { if (this.receiver) await this.receiver.close(); } catch {}
    try { if (this.sender) await this.sender.close(); } catch {}
    try { if (this.client) await this.client.close(); } catch {}
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Event Listener CLI — Send messages to the event listener

Usage:
  node cli.js --local                      Interactive REPL (local simulation, no Service Bus)
  node cli.js --local --send "/help"       Send single message locally
  node cli.js --send "@markbot hello"      Send via Service Bus
  node cli.js --send "/run monitor-azure"  Trigger a task

Modes:
  --local                      Bypass Service Bus, send directly to server's simulate endpoint
                               (default server: http://localhost:3847)

Environment Variables:
  EVENT_SB_CONNECTION_STRING   Service Bus connection string (required unless --local)
  EVENT_INBOUND_QUEUE          Inbound queue name (default: inbound-commands)
  EVENT_REPLY_QUEUE            Reply queue name (default: outbound-replies)
  EVENT_SENDER_ID              Your sender ID (default: cli-user)
  EVENT_LOCAL_URL              Local server URL (default: http://localhost:3847)

Options:
  --send <message>             Send a single message and exit
  --local                      Use local simulation (no Service Bus required)
  --local-url <url>            Override local server URL
  --connection-string <str>    Override Service Bus connection string
  --sender-id <id>             Override sender ID
  --help                       Show this help
`);
    process.exit(0);
  }

  // Parse args
  let connectionString = CONNECTION_STRING;
  let singleMessage = null;
  let localMode = false;
  let localUrl = LOCAL_URL;
  let senderId = SENDER_ID;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--send' && args[i + 1]) {
      singleMessage = args[++i];
    } else if (args[i] === '--connection-string' && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === '--local') {
      localMode = true;
    } else if (args[i] === '--local-url' && args[i + 1]) {
      localUrl = args[++i];
    } else if (args[i] === '--sender-id' && args[i + 1]) {
      senderId = args[++i];
    }
  }

  const cli = new EventCLI({ local: localMode, localUrl, senderId });
  await cli.connect(connectionString);

  if (singleMessage) {
    // Single-shot mode
    const startTime = Date.now();
    const reply = await cli.send(singleMessage);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    cli._printReply(reply);
    console.log(`\n⏱️  ${elapsed}s`);
    await cli.disconnect();
    process.exit(0);
  } else {
    // Interactive REPL
    await cli.startREPL();
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
