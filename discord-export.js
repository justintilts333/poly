#!/usr/bin/env node
// Discord Channel Message Exporter
// Exports all messages from a Discord channel to JSON and plain text files.
//
// Usage (as a server member with your user token):
//   DISCORD_TOKEN=your_user_token node discord-export.js
//
// For a bot token instead:
//   DISCORD_TOKEN=your_bot_token node discord-export.js --bot
//
// How to get your user token:
//   1. Open Discord in your browser (discord.com/app)
//   2. Open DevTools → Network tab
//   3. Reload the page, filter by "api.discord.com"
//   4. Click any request → Headers → find "authorization" value
//
// Output files are saved to data/discord-export-<channelId>-<timestamp>.{json,txt}

const https = require('https');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = '1187661156404445204';
const API_BASE = 'api.discord.com';

function getTokenAndMode() {
  const args = process.argv.slice(2);
  const isBot = args.includes('--bot');
  const tokenFlag = args.findIndex(a => a === '--token');
  const token = tokenFlag !== -1 && args[tokenFlag + 1]
    ? args[tokenFlag + 1]
    : process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('Error: No Discord token provided.');
    console.error('Set DISCORD_TOKEN env var or use --token <token>');
    process.exit(1);
  }
  return { token, isBot };
}

function apiRequest(token, isBot, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_BASE,
      path,
      method: 'GET',
      headers: {
        Authorization: isBot ? `Bot ${token}` : token,
        'User-Agent': 'Mozilla/5.0 (compatible; DiscordExporter/1.0)',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 429) {
          const retryAfter = parseFloat(res.headers['retry-after'] || '1');
          console.log(`Rate limited. Waiting ${retryAfter}s...`);
          setTimeout(() => apiRequest(token, isBot, path).then(resolve).catch(reject), retryAfter * 1000);
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

async function fetchChannelInfo(token, isBot) {
  return apiRequest(token, isBot, `/api/v10/channels/${CHANNEL_ID}`);
}

async function fetchMessageBatch(token, isBot, before = null) {
  let url = `/api/v10/channels/${CHANNEL_ID}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  return apiRequest(token, isBot, url);
}

async function fetchAllMessages(token, isBot) {
  const allMessages = [];
  let before = null;
  let batch = 0;

  console.log(`Fetching messages from channel ${CHANNEL_ID}...`);

  while (true) {
    batch++;
    process.stdout.write(`  Batch ${batch}: fetching up to 100 messages${before ? ` before ${before}` : ''}...`);

    const messages = await fetchMessageBatch(token, isBot, before);

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
  const { token, isBot } = getTokenAndMode();
  console.log(`Mode: ${isBot ? 'bot token' : 'user token'}`);

  // Fetch channel info
  let channelInfo;
  try {
    channelInfo = await fetchChannelInfo(token, isBot);
    console.log(`Channel: #${channelInfo.name} (guild: ${channelInfo.guild_id})`);
  } catch (err) {
    console.error(`Failed to fetch channel info: ${err.message}`);
    if (!isBot) {
      console.error('Make sure your user token is correct (see instructions at top of file).');
    } else {
      console.error('Make sure your bot has access to this channel.');
    }
    process.exit(1);
  }

  // Fetch all messages
  const messages = await fetchAllMessages(token, isBot);

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
