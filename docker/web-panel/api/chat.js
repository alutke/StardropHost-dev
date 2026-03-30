/**
 * StardropHost | web-panel/api/chat.js
 * In-game chat bridge — read chat.log, send messages via SMAPI stdin pipe.
 */

const fs   = require('fs');
const path = require('path');

const CHAT_LOG   = '/home/steam/.local/share/stardrop/chat.log';
const SMAPI_STDIN = '/home/steam/web-panel/data/smapi-stdin';

// Max lines kept in chat.log before truncation (on each write this is a no-op;
// truncation is done opportunistically in getMessages).
const MAX_LINES = 500;

function getMessages(req, res) {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
  const since = parseInt(req.query.since || '0', 10);

  try {
    if (!fs.existsSync(CHAT_LOG)) return res.json({ messages: [] });

    const raw   = fs.readFileSync(CHAT_LOG, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    const messages = lines
      .slice(-limit)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(m => m && (!since || m.ts > since));

    res.json({ messages });
  } catch {
    res.json({ messages: [] });
  }
}

function sendMessage(req, res) {
  const { message, to } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  // Build SMAPI console command:
  //   to blank / 'all' → say <message>  (broadcast as host)
  //   to <player>      → tell <player> <message>  (private via /message)
  const target  = to?.trim();
  const command = (target && target !== 'all')
    ? `tell ${target} ${message.trim()}`
    : `say ${message.trim()}`;

  try {
    if (!fs.existsSync(SMAPI_STDIN)) {
      return res.status(503).json({ error: 'Game is not running' });
    }
    fs.appendFileSync(SMAPI_STDIN, command + '\n');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
}

module.exports = { getMessages, sendMessage };
