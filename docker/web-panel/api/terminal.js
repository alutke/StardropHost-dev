/**
 * StardropHost | web-panel/api/terminal.js
 * SMAPI console access via WebSocket
 * Tails the SMAPI log for output; writes to SMAPI stdin for commands
 */

const fs = require('fs');
const { spawn, execSync, spawnSync } = require('child_process');
const config = require('../server');

// -- Only one terminal session at a time --
let activeTerminal = null;
let activeWs       = null;
let idleTimeout    = null;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// -- Idle timeout --

function resetIdleTimeout() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    sendToWs(activeWs, 'terminal:output',
      '\r\n[StardropHost] Terminal closed due to inactivity (5 min)\r\n');
    closeTerminal();
  }, IDLE_TIMEOUT_MS);
}

// -- Helpers --

function sendToWs(ws, type, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function getSmapiPid() {
  // Must use spawnSync (not execSync) — execSync wraps in 'sh -c' which puts the pattern string
  // in the shell process cmdline, causing pgrep to self-match and always return a PID.
  try {
    const result = spawnSync('pgrep', ['-f', 'StardewModdingAPI'], { encoding: 'utf-8' });
    const pids   = (result.stdout || '').trim().split('\n').filter(Boolean);
    return pids[0] || null;
  } catch {
    return null;
  }
}

// -- Session lifecycle --

function closeTerminal() {
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }

  if (activeTerminal) {
    try { activeTerminal.kill(); } catch {}
    activeTerminal = null;
  }

  if (activeWs) {
    activeWs._smapiPid = null;
    activeWs = null;
  }
}

// -- Route Handlers (called by WebSocket message router in server.js) --

function openTerminal(ws) {
  // Reject if another session is open on a different socket
  if (activeTerminal && activeWs && activeWs !== ws) {
    sendToWs(ws, 'terminal:error',
      'Another terminal session is already active. Only one session allowed at a time.');
    return;
  }

  closeTerminal();

  const smapiPid = getSmapiPid();
  if (!smapiPid) {
    sendToWs(ws, 'terminal:error',
      'SMAPI is not running. Start the server before opening the terminal.');
    return;
  }

  try {
    // Tail the SMAPI log for output — SMAPI writes all console output here
    const tail = spawn('tail', ['-f', '-n', '30', config.SMAPI_LOG], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeTerminal    = tail;
    activeWs          = ws;
    ws._smapiPid      = smapiPid;

    tail.stdout.on('data', data => sendToWs(ws, 'terminal:output', data.toString()));
    tail.stderr.on('data', data => sendToWs(ws, 'terminal:output', data.toString()));

    tail.on('close', () => {
      sendToWs(ws, 'terminal:closed', 'Terminal session ended.');
      closeTerminal();
    });

    sendToWs(ws, 'terminal:opened',
      `[StardropHost] Connected to SMAPI (PID ${smapiPid})\r\n` +
      `[StardropHost] Type SMAPI console commands below. This is not a shell.\r\n`);

    resetIdleTimeout();
  } catch (e) {
    sendToWs(ws, 'terminal:error', `Failed to open terminal: ${e.message}`);
  }
}

function handleInput(ws, data) {
  if (!ws._smapiPid) {
    sendToWs(ws, 'terminal:error', 'No active terminal session. Open terminal first.');
    return;
  }

  if (!data || typeof data !== 'string') return;

  resetIdleTimeout();

  try {
    // Write to SMAPI stdin via /proc/PID/fd/0
    const input = data.endsWith('\n') ? data : `${data}\n`;
    fs.writeFileSync(`/proc/${ws._smapiPid}/fd/0`, input);

    // Echo input back to the client
    sendToWs(ws, 'terminal:output', `> ${data.trim()}\r\n`);
  } catch (e) {
    sendToWs(ws, 'terminal:error', `Failed to send input: ${e.message}`);
  }
}

module.exports = { openTerminal, handleInput, closeTerminal };