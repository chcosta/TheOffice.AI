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

// Config from env or defaults
const CONNECTION_STRING = process.env.EVENT_SB_CONNECTION_STRING || '';
const INBOUND_QUEUE = process.env.EVENT_INBOUND_QUEUE || 'inbound-commands';
const REPLY_QUEUE = process.env.EVENT_REPLY_QUEUE || 'outbound-replies';
const SENDER_ID = process.env.EVENT_SENDER_ID || 'cli-user';

class EventCLI {
  constructor() {
    this.client = null;
    this.sender = null;
    this.receiver = null;
    this.pendingReplies = new Map(); // correlationId → { resolve, timeout }
    this.replyTimeout = 120000; // 2 minutes
  }

  async connect(connectionString) {
    const connStr = connectionString || CONNECTION_STRING;
    if (!connStr) {
      console.error('❌ No connection string. Set EVENT_SB_CONNECTION_STRING or pass --connection-string');
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
    const correlationId = crypto.randomUUID();

    const message = {
      body: {
        senderId: SENDER_ID,
        correlationId,
        content
      },
      correlationId,
      applicationProperties: { senderId: SENDER_ID }
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
        process.stdout.write('⏳ Waiting for reply...');
        const reply = await this.send(input);
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        this._printReply(reply);
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
Event Listener CLI — Send messages to Service Bus event listener

Usage:
  node cli.js                              Interactive REPL mode
  node cli.js --send "@markbot hello"      Send single message, print reply, exit
  node cli.js --send "/help"               Get list of connected assets
  node cli.js --send "/run monitor-azure"  Trigger a task

Environment Variables:
  EVENT_SB_CONNECTION_STRING   Service Bus connection string (required)
  EVENT_INBOUND_QUEUE          Inbound queue name (default: inbound-commands)
  EVENT_REPLY_QUEUE            Reply queue name (default: outbound-replies)
  EVENT_SENDER_ID              Your sender ID (default: cli-user)

Options:
  --send <message>             Send a single message and exit
  --connection-string <str>    Override connection string
  --sender-id <id>             Override sender ID
  --help                       Show this help
`);
    process.exit(0);
  }

  // Parse args
  let connectionString = CONNECTION_STRING;
  let singleMessage = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--send' && args[i + 1]) {
      singleMessage = args[++i];
    } else if (args[i] === '--connection-string' && args[i + 1]) {
      connectionString = args[++i];
    }
  }

  const cli = new EventCLI();
  await cli.connect(connectionString);

  if (singleMessage) {
    // Single-shot mode
    const reply = await cli.send(singleMessage);
    cli._printReply(reply);
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
