// ===========================================
// StardropHost | docker/manager/server.js
// ===========================================
// Sidecar service with Docker socket access.
// Handles container lifecycle operations that
// the web panel cannot do from inside the
// main container.
// ===========================================

const fs   = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT        = parseInt(process.env.MANAGER_PORT || '18700', 10);
const PROJECT_DIR = process.env.PROJECT_DIR || '/workspace';
const COMPOSE_FILE     = process.env.COMPOSE_FILE || `${PROJECT_DIR}/docker-compose.yml`;
const COMPOSE_OVERRIDE = `${PROJECT_DIR}/docker-compose.override.yml`;

const DEFAULT_ENV_FILE = `${PROJECT_DIR}/.env`;
const RUNTIME_ENV_FILE = `${PROJECT_DIR}/data/panel/runtime.env`;

const ALLOWED_SERVICES = new Set(['stardrop-server', 'stardrop-steam-auth', 'stardrop-gog-downloader']);

const PREFIX = process.env.CONTAINER_PREFIX || 'stardrop';
const SERVICE_CONTAINERS = {
  'stardrop-server':         PREFIX,
  'stardrop-steam-auth':     `${PREFIX}-steam-auth`,
  'stardrop-gog-downloader': `${PREFIX}-gog-downloader`,
};

// -- Helpers --

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try   { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

function buildComposeEnv() {
  return {
    ...process.env,
    ...parseEnvFile(DEFAULT_ENV_FILE),
    ...parseEnvFile(RUNTIME_ENV_FILE),
  };
}

// Extract top-level service names from a compose YAML string.
// Handles 2-space or 4-space indented service keys.
function extractServiceNames(yaml) {
  const lines = yaml.split('\n');
  let inServices = false;
  let serviceIndent = 0;
  const services = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (/^services\s*:/.test(trimmed)) { inServices = true; continue; }
    if (!inServices) continue;
    if (indent === 0 && trimmed.includes(':')) break; // new top-level key ends services block
    if (serviceIndent === 0 && indent > 0) serviceIndent = indent;
    if (indent === serviceIndent) {
      const m = line.trimStart().match(/^([\w-][\w.-]*)\s*:/);
      if (m) services.push(m[1]);
    }
  }
  return services;
}

// -- Actions --

function recreateService(service) {
  const env = buildComposeEnv();
  const containerName = SERVICE_CONTAINERS[service];
  const command = [
    containerName ? `docker rm -f ${containerName} >/dev/null 2>&1 || true` : '',
    `docker compose -f ${COMPOSE_FILE} --project-directory ${PROJECT_DIR} up -d --no-deps ${service}`,
  ].filter(Boolean).join(' && ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR, env, detached: true, stdio: 'ignore',
  });
  child.unref();
}

function stopService(service) {
  const containerName = SERVICE_CONTAINERS[service];
  const command = `docker stop ${containerName} >/dev/null 2>&1 || true`;

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR, env: buildComposeEnv(), detached: true, stdio: 'ignore',
  });
  child.unref();
}

// Services that require a compose profile to start (excluded from plain `up -d`)
const PROFILE_SERVICES = {
  'stardrop-steam-auth':     'steam-auth',
  'stardrop-gog-downloader': 'gog-downloader',
};

function startService(service) {
  const profile = PROFILE_SERVICES[service] ? `--profile ${PROFILE_SERVICES[service]} ` : '';
  const command = `docker compose -f ${COMPOSE_FILE} --project-directory ${PROJECT_DIR} ${profile}up -d --no-deps ${service}`;

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR, env: buildComposeEnv(), detached: true, stdio: 'ignore',
  });
  child.unref();
}

// -- Remote compose management --

function getRemoteStatus() {
  if (!fs.existsSync(COMPOSE_OVERRIDE)) {
    return Promise.resolve({ configured: false, services: [] });
  }

  let yaml;
  try   { yaml = fs.readFileSync(COMPOSE_OVERRIDE, 'utf8'); }
  catch { return Promise.resolve({ configured: false, services: [] }); }

  const serviceNames = extractServiceNames(yaml);
  if (!serviceNames.length) {
    return Promise.resolve({ configured: true, yaml, services: [] });
  }

  return new Promise(resolve => {
    const child = spawn('docker', [
      'compose',
      '-f', COMPOSE_FILE,
      '-f', COMPOSE_OVERRIDE,
      '--project-directory', PROJECT_DIR,
      'ps', '--format', 'json',
      ...serviceNames,
    ], { env: buildComposeEnv() });

    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      const statuses = {};
      const text = out.trim();
      try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const s of arr) statuses[s.Service || s.Name] = s.State || s.Status || '';
      } catch {
        for (const line of text.split('\n').filter(l => l.trim().startsWith('{'))) {
          try {
            const s = JSON.parse(line);
            statuses[s.Service || s.Name] = s.State || s.Status || '';
          } catch {}
        }
      }
      const services = serviceNames.map(name => {
        const state = statuses[name] || 'unknown';
        return { name, state, running: /^running/i.test(state) || state === 'Up' };
      });
      resolve({ configured: true, yaml, services, anyRunning: services.some(s => s.running) });
    });
    child.on('error', () => {
      resolve({
        configured: true, yaml,
        services: serviceNames.map(n => ({ name: n, state: 'unknown', running: false })),
        anyRunning: false,
      });
    });
  });
}

function applyRemote(yaml) {
  const serviceNames = extractServiceNames(yaml);
  if (!serviceNames.length) throw new Error('No services found in compose YAML');

  // Strip obsolete 'version:' top-level key — Docker Compose v2 ignores it with a warning
  const cleaned = yaml.split('\n').filter(l => !/^\s*version\s*:/.test(l)).join('\n').replace(/^\n+/, '');
  fs.writeFileSync(COMPOSE_OVERRIDE, cleaned, { mode: 0o644 });

  const command = [
    `docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_OVERRIDE}`,
    `--project-directory ${PROJECT_DIR}`,
    `up -d --no-recreate ${serviceNames.join(' ')}`,
  ].join(' ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR, env: buildComposeEnv(), detached: true, stdio: 'ignore',
  });
  child.unref();
  return serviceNames;
}

function startRemote() {
  if (!fs.existsSync(COMPOSE_OVERRIDE)) throw new Error('No remote compose config found');
  const yaml = fs.readFileSync(COMPOSE_OVERRIDE, 'utf8');
  const serviceNames = extractServiceNames(yaml);
  if (!serviceNames.length) throw new Error('No services found in saved config');

  const command = [
    `docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_OVERRIDE}`,
    `--project-directory ${PROJECT_DIR}`,
    `up -d --no-recreate ${serviceNames.join(' ')}`,
  ].join(' ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR, env: buildComposeEnv(), detached: true, stdio: 'ignore',
  });
  child.unref();
  return serviceNames;
}

function stopRemote() {
  if (!fs.existsSync(COMPOSE_OVERRIDE)) return;
  const yaml = fs.readFileSync(COMPOSE_OVERRIDE, 'utf8');
  const serviceNames = extractServiceNames(yaml);
  if (!serviceNames.length) return;

  // rm -s stops then removes containers
  const command = [
    `docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_OVERRIDE}`,
    `--project-directory ${PROJECT_DIR}`,
    `rm -sf ${serviceNames.join(' ')}`,
  ].join(' ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR, env: buildComposeEnv(), detached: true, stdio: 'ignore',
  });
  child.unref();
}

async function removeRemote() {
  if (!fs.existsSync(COMPOSE_OVERRIDE)) return;
  const yaml = fs.readFileSync(COMPOSE_OVERRIDE, 'utf8');
  const serviceNames = extractServiceNames(yaml);

  if (serviceNames.length) {
    // Wait for containers to actually stop and be removed before deleting the config.
    // This prevents Docker from creating duplicate numbered containers on re-apply.
    await new Promise(resolve => {
      const command = [
        `docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_OVERRIDE}`,
        `--project-directory ${PROJECT_DIR}`,
        `rm -sf ${serviceNames.join(' ')}`,
      ].join(' ');
      const child = spawn('sh', ['-lc', command], {
        cwd: PROJECT_DIR, env: buildComposeEnv(), stdio: 'ignore',
      });
      child.on('close', resolve);
      child.on('error', resolve);
    });
  }

  try { fs.unlinkSync(COMPOSE_OVERRIDE); } catch {}
}

// -- Install new instance --

let _installProcess = null;
const INSTALL_LOG  = path.join(PROJECT_DIR, 'data', 'panel', 'install-instance.log');
const INSTALL_STATUS = path.join(PROJECT_DIR, 'data', 'panel', 'install-instance-status.json');

function writeInstallStatus(status, message) {
  try {
    fs.mkdirSync(path.dirname(INSTALL_STATUS), { recursive: true });
    fs.writeFileSync(INSTALL_STATUS, JSON.stringify({ status, message, updatedAt: Date.now() }));
  } catch {}
}

function installInstance() {
  if (_installProcess && !_installProcess.exitCode !== null) return false; // already running

  const env       = buildComposeEnv();
  const parentDir = path.dirname(PROJECT_DIR);

  // Clear old log
  try { fs.mkdirSync(path.dirname(INSTALL_LOG), { recursive: true }); fs.writeFileSync(INSTALL_LOG, ''); } catch {}
  writeInstallStatus('running', 'Starting installation...');

  const command = [
    'docker run --rm --name stardrop-install',
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${parentDir}:${parentDir}`,
    `-e STARDROP_REAL_HOME=${parentDir}`,
    `-w ${parentDir}`,
    'alpine',
    `sh -c "apk add -q git bash curl docker-cli docker-cli-compose && git config --global --add safe.directory '*' && bash ${PROJECT_DIR}/quick-start.sh --yes"`,
  ].join(' ');

  const logFd = fs.openSync(INSTALL_LOG, 'a');
  const child = spawn('sh', ['-lc', command], {
    cwd: parentDir, env, detached: true, stdio: ['ignore', logFd, logFd],
  });

  _installProcess = child;

  child.on('close', (code) => {
    try { fs.closeSync(logFd); } catch {}
    writeInstallStatus(code === 0 ? 'done' : 'error', code === 0 ? 'Installation complete' : `Exited with code ${code}`);
    _installProcess = null;
  });

  child.unref();
  return true;
}

function getInstallLog() {
  const running = _installProcess !== null;
  let status = null;
  try { status = JSON.parse(fs.readFileSync(INSTALL_STATUS, 'utf-8')); } catch {}
  let lines = [];
  try {
    const raw = fs.readFileSync(INSTALL_LOG, 'utf-8');
    lines = raw.split('\n').filter(l => l.trim()).slice(-100);
  } catch {}
  return { running, status: status?.status || (running ? 'running' : 'idle'), lines };
}

function updateServer(updateAll = false) {
  const env        = buildComposeEnv();
  const parentDir  = path.dirname(PROJECT_DIR);
  const extraFlag  = updateAll ? ' --all' : '';

  // When updating all instances we mount the parent directory so sibling
  // update.sh scripts are accessible inside the Alpine container.
  const mounts = [
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${PROJECT_DIR}:${PROJECT_DIR}`,
    ...(updateAll ? [`-v ${parentDir}:${parentDir}`] : []),
  ].join(' ');

  const command = [
    `docker run --rm ${mounts}`,
    `-w ${PROJECT_DIR}`,
    'alpine',
    `sh -c "apk add -q git bash docker-cli docker-cli-compose && git config --global --add safe.directory '*' && bash update.sh${extraFlag}"`,
  ].join(' ');

  const child = spawn('sh', ['-lc', command], {
    cwd: PROJECT_DIR, env, detached: true, stdio: 'ignore',
  });
  child.unref();
}

// -- Routes --

const server = http.createServer(async (req, res) => {

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/recreate') {
    try {
      const body = await readJson(req);
      const service = body?.service ? String(body.service) : 'stardrop-server';
      if (!ALLOWED_SERVICES.has(service)) { sendJson(res, 400, { error: 'Unsupported service' }); return; }
      recreateService(service);
      sendJson(res, 202, { success: true, service, action: 'recreate' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/stop') {
    try {
      const body = await readJson(req);
      const service = body?.service ? String(body.service) : 'stardrop-server';
      if (!ALLOWED_SERVICES.has(service)) { sendJson(res, 400, { error: 'Unsupported service' }); return; }
      stopService(service);
      sendJson(res, 202, { success: true, service, action: 'stop' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/start') {
    try {
      const body = await readJson(req);
      const service = body?.service ? String(body.service) : 'stardrop-server';
      if (!ALLOWED_SERVICES.has(service)) { sendJson(res, 400, { error: 'Unsupported service' }); return; }
      startService(service);
      sendJson(res, 202, { success: true, service, action: 'start' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/update') {
    try {
      const body = await readJson(req);
      updateServer(body?.updateAll === true);
      sendJson(res, 202, { success: true, action: 'update' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && req.url === '/install-instance') {
    try {
      const started = installInstance();
      if (!started) return sendJson(res, 409, { error: 'Installation already in progress' });
      sendJson(res, 202, { success: true, action: 'install-instance' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && req.url === '/install-instance/log') {
    try { sendJson(res, 200, getInstallLog()); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // Remote compose status
  if (req.method === 'GET' && req.url === '/remote/status') {
    try {
      const status = await getRemoteStatus();
      sendJson(res, 200, status);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // Apply compose YAML and start services
  if (req.method === 'POST' && req.url === '/remote/apply') {
    try {
      const body = await readJson(req, 200 * 1024); // 200KB limit for YAML
      const yaml = body?.yaml ? String(body.yaml).trim() : '';
      if (!yaml) { sendJson(res, 400, { error: 'yaml is required' }); return; }
      if (!yaml.includes('services:')) { sendJson(res, 400, { error: 'YAML must contain a services: block' }); return; }
      const services = applyRemote(yaml);
      sendJson(res, 202, { success: true, action: 'apply', services });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // Start (resume) existing remote service
  if (req.method === 'POST' && req.url === '/remote/start') {
    try {
      const services = startRemote();
      sendJson(res, 202, { success: true, action: 'start', services });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // Stop remote service containers (keep config)
  if (req.method === 'POST' && req.url === '/remote/stop') {
    try {
      stopRemote();
      sendJson(res, 202, { success: true, action: 'stop' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // Remove remote service (stop + delete config) — awaits container removal
  if (req.method === 'POST' && req.url === '/remote/remove') {
    try {
      await removeRemote();
      sendJson(res, 200, { success: true, action: 'remove' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // Docker container logs
  if (req.method === 'GET' && req.url.startsWith('/docker-logs')) {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const lines  = Math.min(parseInt(urlObj.searchParams.get('lines') || '500', 10), 5000);
      const result = spawnSync('docker', ['logs', '--tail', String(lines), 'stardrop'], { encoding: 'utf-8' });
      const output = (result.stdout || '') + (result.stderr || '');
      sendJson(res, 200, { lines: output.split('\n') });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[StardropHost Manager] Listening on http://0.0.0.0:${PORT}`);
});
