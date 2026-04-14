/**
 * StardropHost | web-panel/api/logs.js
 * Log reading and WebSocket streaming
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const config = require('../server');

// -- Log file mapping --
const LOG_FILES = {
  all:    'smapi-latest.log',
  error:  'errors.log',
  mod:    'mods.log',
  server: 'server.log',
  game:   'game.log',
};

// smapi-prev.txt = previous session, copied by crash-monitor.sh before each launch
// (SMAPI purges all SMAPI-*.txt files on startup via PurgeNormalLogs(), so we preserve it ourselves)
function getSmapiOldLogPath() {
  return path.join(config.LOG_DIR, 'smapi-prev.txt');
}

// Combine previous session + current session with a separator line.
// Reads SMAPI-old.txt (if present) then SMAPI-latest.txt.
function readSmapiWithHistory() {
  const oldPath = getSmapiOldLogPath();
  const parts   = [];

  if (fs.existsSync(oldPath)) {
    try {
      parts.push(fs.readFileSync(oldPath, 'utf-8'));
      parts.push('══════════════════════ PREVIOUS SESSION END / CURRENT SESSION START ══════════════════════');
    } catch { /* skip old log if unreadable */ }
  }

  if (fs.existsSync(config.SMAPI_LOG)) {
    try { parts.push(fs.readFileSync(config.SMAPI_LOG, 'utf-8')); } catch { /* skip */ }
  }

  return parts.join('\n');
}

function getCategorizedLogPath(filter) {
  return path.join(config.LOG_DIR, 'categorized', LOG_FILES[filter] || LOG_FILES.all);
}

function getLogSource(filter) {
  if (filter === 'all') {
    return { path: config.SMAPI_LOG, filtered: false };
  }
  if (filter === 'smapi') {
    return { path: config.SMAPI_LOG, filtered: true };
  }

  const categorizedPath = getCategorizedLogPath(filter);
  if (fs.existsSync(categorizedPath)) {
    return { path: categorizedPath, filtered: false };
  }

  return { path: config.SMAPI_LOG, filtered: true };
}

function isSmapiSource(line) {
  return /\[\d{2}:\d{2}:\d{2}\s+\w+\s+SMAPI\]/i.test(line);
}

function matchesFilter(filter, line) {
  if (!line || filter === 'all') return true;

  if (filter === 'smapi') {
    return isSmapiSource(line);
  }
  if (filter === 'error') {
    return /ERROR|FATAL|Exception/i.test(line);
  }
  // "game" tab = everything that is NOT a pure SMAPI-sourced line
  if (filter === 'game') {
    return !isSmapiSource(line);
  }
  return true;
}

function parseLogLevel(line) {
  if (/\bERROR\b/i.test(line)) return 'error';
  if (/\bWARN\b/i.test(line))  return 'warn';
  if (/\bDEBUG\b/i.test(line)) return 'debug';
  return 'info';
}

// Lines safe to hide — not real errors in a server environment
const LOG_SUPPRESS = [
  "Steam achievements won't work because Steam isn't loaded",
];

// Core SMAPI sources that don't need a leader prefix
const CORE_SOURCES = new Set(['smapi', 'game', 'stardrop', 'stardropsavegamemanager', 'stardropgamemanager', 'server']);

// Transform a raw SMAPI log line:
//  1. Strip "TRACE " from the inner bracket so it reads [HH:MM:SS Source]
//  2. For non-core (mod) sources, prepend "Source Name - " before the message
function transformLogLine(text) {
  // Strip TRACE level from inner timestamp bracket
  let t = text.replace(/(\[\d{2}:\d{2}:\d{2})\s+TRACE\s+/g, '$1 ');

  // Match: optional outer timestamp + inner [HH:MM:SS Source] + message
  const m = t.match(/^((?:\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?)(\[(\d{2}:\d{2}:\d{2})\s+([^\]]+)\])\s+(.+)$/s);
  if (m) {
    const outer   = m[1];
    const bracket = m[2];
    const source  = m[4].trim();
    const message = m[5];
    if (!CORE_SOURCES.has(source.toLowerCase())) {
      // CamelCase → space-separated for display
      const label = source.replace(/([a-z])([A-Z])/g, '$1 $2');
      t = `${outer}${bracket} ${label} - ${message}`;
    }
  }

  return t;
}

// -- HTTP Handlers --

function getLogs(req, res) {
  const filter = req.query.type || 'all';
  const lines  = parseInt(req.query.lines || '200', 10);
  const search = req.query.search || '';

  const source  = getLogSource(filter);
  const logPath = source.path;

  // For raw SMAPI log tabs (all/smapi), include previous session from SMAPI-old.txt
  const useHistory = (filter === 'all' || filter === 'smapi');

  if (!useHistory && !fs.existsSync(logPath)) {
    return res.json({ lines: [], total: 0, file: logPath, exists: false });
  }

  try {
    const content  = useHistory ? readSmapiWithHistory() : fs.readFileSync(logPath, 'utf-8');
    if (!content) return res.json({ lines: [], total: 0, file: path.basename(logPath), exists: false });
    let allLines   = content.split('\n').filter(l => l.trim());

    if (source.filtered) {
      allLines = allLines.filter(line => matchesFilter(filter, line));
    }

    if (search) {
      const searchLower = search.toLowerCase();
      allLines = allLines.filter(l => l.toLowerCase().includes(searchLower));
    }

    const result = allLines
      .filter(line => !LOG_SUPPRESS.some(s => line.includes(s)))
      .slice(-lines)
      .map(line => ({ text: transformLogLine(line), level: parseLogLevel(line) }));

    res.json({ lines: result, total: allLines.length, file: path.basename(logPath), exists: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read log file', details: e.message });
  }
}

function getErrors(req, res) {
  req.query.type = 'error';
  return getLogs(req, res);
}

function getServerLogs(req, res) {
  req.query.type = 'server';
  return getLogs(req, res);
}

function getModLogs(req, res) {
  req.query.type = 'mod';
  return getLogs(req, res);
}

function getGameLogs(req, res) {
  req.query.type = 'game';
  return getLogs(req, res);
}

// -- WebSocket log streaming --

function subscribeLogs(ws, filter) {
  const source  = getLogSource(filter);
  const logPath = source.path;

  if (ws._logWatcher) {
    ws._logWatcher.close();
    ws._logWatcher = null;
  }

  if (!fs.existsSync(logPath)) {
    ws.send(JSON.stringify({
      type: 'log',
      line: { text: `Log file not found: ${path.basename(logPath)}`, level: 'warn' },
    }));
    return;
  }

  let fileSize = 0;
  try { fileSize = fs.statSync(logPath).size; } catch {}

  const watcher = fs.watch(logPath, (eventType) => {
    if (eventType !== 'change') return;

    try {
      const stat = fs.statSync(logPath);

      // File was truncated (log rotation)
      if (stat.size <= fileSize) fileSize = 0;

      const stream = fs.createReadStream(logPath, { start: fileSize, encoding: 'utf-8' });
      let newData = '';

      stream.on('data', (chunk) => { newData += chunk; });
      stream.on('end', () => {
        fileSize = stat.size;
        const lines = newData.split('\n').filter(l => l.trim());

        for (const line of lines) {
          if (source.filtered && !matchesFilter(filter, line)) continue;
          if (LOG_SUPPRESS.some(s => line.includes(s))) continue;
          if (ws.readyState !== 1) break;

          ws.send(JSON.stringify({
            type: 'log',
            line: { text: transformLogLine(line), level: parseLogLevel(line) },
          }));
        }
      });
    } catch {}
  });

  ws._logWatcher = watcher;

  ws.send(JSON.stringify({
    type:   'log:subscribed',
    filter,
    file:   path.basename(logPath),
  }));
}

// -- Setup log (entrypoint.sh progress, visible during wizard) --

const SETUP_LOG_FILE = '/home/steam/.local/share/stardrop/logs/setup.log';

function getSetupLog(req, res) {
  const lines = Math.min(parseInt(req.query.lines || '120', 10), 500);

  if (!fs.existsSync(SETUP_LOG_FILE)) {
    return res.json({ lines: [], exists: false });
  }

  try {
    const content  = fs.readFileSync(SETUP_LOG_FILE, 'utf-8');
    const allLines = content.split('\n').filter(l => l.trim());

    const result = allLines.slice(-lines).map(line => ({
      text:  line,
      level: /\[ERROR\]/i.test(line) ? 'error'
           : /\[WARN\]/i.test(line)  ? 'warn'
           : /\[STEP\]/i.test(line)  ? 'info'
           : 'info',
    }));

    res.json({ lines: result, total: allLines.length, exists: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read setup log', details: e.message });
  }
}

// -- Docker container logs (proxied from manager) --

function getDockerLogs(req, res) {
  const lines = Math.min(parseInt(req.query.lines || '500', 10), 5000);
  const managerUrl = new URL(`/docker-logs?lines=${lines}`, config.MANAGER_URL);

  const request = http.get({
    hostname: managerUrl.hostname,
    port:     managerUrl.port,
    path:     managerUrl.pathname + managerUrl.search,
    timeout:  10000,
  }, (response) => {
    let data = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        res.json(parsed);
      } catch { res.status(500).json({ error: 'Invalid response from manager' }); }
    });
  });

  request.on('error', (e) => {
    res.status(503).json({ error: 'Manager unavailable', details: e.message });
  });
  request.on('timeout', () => {
    request.destroy();
    res.status(504).json({ error: 'Manager timeout' });
  });
}

module.exports = {
  getLogs,
  getErrors,
  getServerLogs,
  getModLogs,
  getGameLogs,
  subscribeLogs,
  getSetupLog,
  getDockerLogs,
};