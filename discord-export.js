#!/usr/bin/env node
// Discord Channel Message Exporter
// Exports all messages from a Discord channel to JSON and plain text files.
//
// Usage:
//   DISCORD_TOKEN=your_bot_token node discord-export.js
//
// The token can also be passed via --token flag:
//   node discord-export.js --token your_bot_token
//
// Output files are saved to data/discord-export-<channelId>-<timestamp>.{json,txt}

const https = require('https');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = '1187661156404445204';
const API_BASE = 'api.discord.com';

function getToken() {
  const args = process.argv.slice(2);
  const tokenFlag = args.findIndex(a => a === '--token');
  if (tokenFlag !== -1 && args[tokenFlag + 1]) return args[tokenFlag + 1];
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  console.error('Error: No Discord token provided.');
  console.error('Set DISCORD_TOKEN env var or use --token <token>');
  process.exit(1);
}

function apiRequest(token, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_BASE,
      path,
      method: 'GET',
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'DiscordExporter/1.0',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 429) {
          const retryAfter = parseFloat(res.headers['retry-after'] || '1');
          console.log(`Rate limited. Waiting ${retryAfter}s...`);
          setTimeout(() => apiRequest(token, path).then(resolve).catch(reject), retryAfter * 1000);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchChannelInfo(token) {
  return apiRequest(token, `/api/v10/channels/${CHANNEL_ID}`);
}

async function fetchMessageBatch(token, before = null) {
  let url = `/api/v10/channels/${CHANNEL_ID}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  return apiRequest(token, url);
}

async function fetchAllMessages(token) {
  const allMessages = [];
  let before = null;
  let batch = 0;

  console.log(`Fetching messages from channel ${CHANNEL_ID}...`);

  while (true) {
    batch++;
    process.stdout.write(`  Batch ${batch}: fetching up to 100 messages${before ? ` before ${before}` : ''}...`);

    const messages = await fetchMessageBatch(token, before);

    if (!messages.length) {
      console.log(' done (no more messages).');
      break;
    }

    allMessages.push(...messages);
    console.log(` got ${messages.length} (total: ${allMessages.length})`);

    if (messages.length < 100) break;

    before = messages[messages.length - 1].id;

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  return allMessages;
}

function formatMessage(msg) {
  const ts = new Date(msg.timestamp).toISOString();
  const author = msg.author
    ? `${msg.author.username}${msg.author.discriminator && msg.author.discriminator !== '0' ? '#' + msg.author.discriminator : ''}`
    : 'Unknown';
  const content = msg.content || '';
  const attachments = (msg.attachments || []).map(a => `[Attachment: ${a.url}]`).join(' ');
  const embeds = (msg.embeds || [])
    .filter(e => e.title || e.description || e.url)
    .map(e => `[Embed: ${[e.title, e.description, e.url].filter(Boolean).join(' | ')}]`)
    .join(' ');

  const parts = [content, attachments, embeds].filter(Boolean).join(' ');
  return `[${ts}] ${author}: ${parts || '(no text content)'}`;
}

async function main() {
  const token = getToken();

  // Fetch channel info
  let channelInfo;
  try {
    channelInfo = await fetchChannelInfo(token);
    console.log(`Channel: #${channelInfo.name} (guild: ${channelInfo.guild_id})`);
  } catch (err) {
    console.error(`Failed to fetch channel info: ${err.message}`);
    console.error('Make sure your bot has access to this channel.');
    process.exit(1);
  }

  // Fetch all messages
  const messages = await fetchAllMessages(token);

  if (!messages.length) {
    console.log('No messages found.');
    process.exit(0);
  }

  // Sort oldest-first
  messages.sort((a, b) => (a.id > b.id ? 1 : -1));

  console.log(`\nTotal messages fetched: ${messages.length}`);

  // Ensure output directory exists
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `discord-export-${CHANNEL_ID}-${timestamp}`;

  // Save JSON
  const jsonPath = path.join(dataDir, `${baseName}.json`);
  const exportData = {
    channel: {
      id: CHANNEL_ID,
      name: channelInfo.name,
      guild_id: channelInfo.guild_id,
    },
    exported_at: new Date().toISOString(),
    message_count: messages.length,
    messages,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`JSON saved: ${jsonPath}`);

  // Save plain text
  const txtPath = path.join(dataDir, `${baseName}.txt`);
  const header = [
    `Discord Channel Export`,
    `Channel: #${channelInfo.name} (${CHANNEL_ID})`,
    `Guild ID: ${channelInfo.guild_id}`,
    `Exported: ${new Date().toISOString()}`,
    `Messages: ${messages.length}`,
    '='.repeat(80),
    '',
  ].join('\n');
  const lines = messages.map(formatMessage).join('\n');
  fs.writeFileSync(txtPath, header + lines + '\n');
  console.log(`Text saved: ${txtPath}`);

  const first = new Date(messages[0].timestamp).toISOString();
  const last = new Date(messages[messages.length - 1].timestamp).toISOString();
  console.log(`\nDate range: ${first} → ${last}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
