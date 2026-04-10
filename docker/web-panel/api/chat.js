/**
 * StardropHost | web-panel/api/chat.js
 * In-game chat bridge — read chat.log, send messages via SMAPI stdin pipe.
 */

const fs   = require('fs');
const path = require('path');

const CHAT_LOG   = '/home/steam/.local/share/stardrop/chat.log';
const SMAPI_STDIN = '/home/steam/web-panel/data/smapi-stdin';

const MAX_LINES = 500;

function _readLines() {
  if (!fs.existsSync(CHAT_LOG)) return [];
  return fs.readFileSync(CHAT_LOG, 'utf-8').trim().split('\n').filter(Boolean);
}

function _parseLines(lines) {
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function getMessages(req, res) {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
  const since = parseInt(req.query.since || '0', 10);
  try {
    const messages = _parseLines(_readLines())
      .slice(-limit)
      .filter(m => !since || m.ts > since);
    res.json({ messages });
  } catch {
    res.json({ messages: [] });
  }
}

function sendMessage(req, res) {
  const { message, to } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

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
  } catch {
    res.status(500).json({ error: 'Failed to send message' });
  }
}

// DELETE /api/chat/messages
// body: { all: true }           → truncate entire log
// body: { channel: 'world' }    → remove all non-DM messages
// body: { channel: '<name>' }   → remove DM messages to/from <name>
function clearMessages(req, res) {
  try {
    const { all, channel } = req.body || {};
    if (all) {
      fs.writeFileSync(CHAT_LOG, '');
      return res.json({ success: true });
    }
    if (!channel) return res.status(400).json({ error: 'channel or all required' });

    const lines   = _readLines();
    const msgs    = _parseLines(lines);
    let   kept;
    if (channel === 'world') {
      // Keep only DM messages (those with a real to: field)
      kept = msgs.filter(m => m.to && m.to !== 'all');
    } else {
      // Keep messages NOT involving this player as a DM partner
      kept = msgs.filter(m => {
        const isDm = m.to && m.to !== 'all';
        if (!isDm) return true;
        return m.from !== channel && m.to !== channel;
      });
    }
    fs.writeFileSync(CHAT_LOG, kept.map(m => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : ''));
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear chat log' });
  }
}

// GET /api/chat/download → full log as formatted plain text
function downloadMessages(req, res) {
  try {
    const msgs = _parseLines(_readLines());
    const lines = msgs.map(m => {
      const time = new Date(m.ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const isDm = m.to && m.to !== 'all';
      const from = m.from || 'System';
      if (isDm) return `[${time}] (DM) ${from} → ${m.to}: ${m.message}`;
      return `[${time}] ${from}: ${m.message}`;
    });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="chat-log.txt"');
    res.send(lines.join('\n'));
  } catch {
    res.status(500).json({ error: 'Failed to download chat log' });
  }
}

function getLastChatTs() {
  try {
    const lines = _readLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = JSON.parse(lines[i]);
      if (m?.ts) return m.ts;
    }
  } catch {}
  return 0;
}

module.exports = { getMessages, sendMessage, clearMessages, downloadMessages, getLastChatTs };
