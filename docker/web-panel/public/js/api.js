/**
 * StardropHost | web-panel/public/js/api.js
 * API helper — token management and fetch wrapper
 */

const API = {
  token: localStorage.getItem('panel_token'),

  async fetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    try {
      const res = await fetch(url, { ...options, headers });

      if (res.status === 401) {
        this.token = null;
        localStorage.removeItem('panel_token');
        window.location.href = '/login.html';
        return null;
      }

      return res;
    } catch (err) {
      console.error('[API] fetch error:', err);
      throw err;
    }
  },

  async get(url) {
    const res = await this.fetch(url);
    return res ? res.json() : null;
  },

  async post(url, body) {
    const res = await this.fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res ? res.json() : null;
  },

  async put(url, body) {
    const res = await this.fetch(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return res ? res.json() : null;
  },

  async del(url, body) {
    const opts = { method: 'DELETE' };
    if (body) opts.body = JSON.stringify(body);
    const res = await this.fetch(url, opts);
    return res ? res.json() : null;
  },

  // Upload a file as base64 — used by save and mod upload endpoints
  async upload(url, file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = reader.result.split(',')[1]; // strip data:...;base64,
          const res  = await this.post(url, { filename: file.name, data });
          resolve(res);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  },

  getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws?token=${encodeURIComponent(this.token)}`;
  },
};