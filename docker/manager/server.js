// ===========================================
// StardropHost | docker/manager/server.js
// ===========================================
// Sidecar service with Docker socket access.
// Handles container lifecycle operations that
// the web panel cannot do from inside the
// main container.
//
// External Compose deployment mode: this manager does
// NOT run docker compose commands. It operates
// on existing containers created by the external deployment tool.
// ===========================================

const http = require('http');
const { spawn, spawnSync } = require('child_process');

const PORT           = parseInt(process.env.MANAGER_PORT || '18700', 10);
const MANAGER_SECRET = process.env.MANAGER_SECRET || '';
const PREFIX = process.env.CONTAINER_PREFIX || 'stardrop';

const ALLOWED_SERVICES = new Set(['stardrop-server', 'stardrop-steam-auth', 'stardrop-gog-downloader']);

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

// -- Actions --

function restartService(service) {
  const containerName = SERVICE_CONTAINERS[service];
  if (!containerName) return;
  const child = spawn('docker', ['restart', containerName], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
}

function stopService(service) {
  const containerName = SERVICE_CONTAINERS[service];
  if (!containerName) return;
  const child = spawn('docker', ['stop', containerName], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
}

function startService(service) {
  const containerName = SERVICE_CONTAINERS[service];
  if (!containerName) return;
  const child = spawn('docker', ['start', containerName], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
}

// -- Routes --

const server = http.createServer(async (req, res) => {

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (MANAGER_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${MANAGER_SECRET}`) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/recreate') {
    try {
      const body = await readJson(req);
      const service = body?.service ? String(body.service) : 'stardrop-server';
      if (!ALLOWED_SERVICES.has(service)) { sendJson(res, 400, { error: 'Unsupported service' }); return; }
      restartService(service);
      sendJson(res, 202, { success: true, service, action: 'restart' });
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
    sendJson(res, 501, {
      error: 'Updates are managed externally. Push to the main branch to trigger a new image build, then redeploy the Compose stack.'
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/install-instance') {
    sendJson(res, 501, {
      error: 'Instance installation is managed by the external Compose deployment tool.'
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/install-instance/log') {
    sendJson(res, 501, {
      error: 'Instance installation is managed by the external Compose deployment tool.'
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/uninstall-instance') {
    sendJson(res, 501, {
      error: 'Instance removal is managed by the external Compose deployment tool.'
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/uninstall-instance/log') {
    sendJson(res, 501, {
      error: 'Instance removal is managed by the external Compose deployment tool.'
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/remote/status') {
    sendJson(res, 501, {
      error: 'Remote compose management is not supported in external-compose deployments.'
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/remote/apply') {
    sendJson(res, 501, {
      error: 'Remote compose management is not supported in external-compose deployments.'
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/remote/start') {
    sendJson(res, 501, {
      error: 'Remote compose management is not supported in external-compose deployments.'
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/remote/stop') {
    sendJson(res, 501, {
      error: 'Remote compose management is not supported in external-compose deployments.'
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/remote/remove') {
    sendJson(res, 501, {
      error: 'Remote compose management is not supported in external-compose deployments.'
    });
    return;
  }

  // Docker container logs
  if (req.method === 'GET' && req.url.startsWith('/docker-logs')) {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const lines  = Math.min(parseInt(urlObj.searchParams.get('lines') || '500', 10), 5000);
      const containerName = SERVICE_CONTAINERS['stardrop-server'];
      const result = spawnSync('docker', ['logs', '--tail', String(lines), containerName], { encoding: 'utf-8' });
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
