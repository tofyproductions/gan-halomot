/**
 * HTTP client for the agent→server channel. Uses native fetch (Node 18+) so
 * we avoid adding axios/node-fetch as deps. Retries with exponential backoff
 * on network errors and 5xx responses; does NOT retry on 4xx (client bugs).
 */
const log = require('./logger');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class ServerClient {
  constructor({ serverUrl, branchId, agentSecret, timeoutMs, retryMax, retryBaseMs }) {
    if (!serverUrl) throw new Error('ServerClient: serverUrl required');
    if (!branchId)  throw new Error('ServerClient: branchId required');
    if (!agentSecret) throw new Error('ServerClient: agentSecret required');
    this.base = serverUrl.replace(/\/+$/, '');
    this.branchId = branchId;
    this.agentSecret = agentSecret;
    this.timeoutMs = timeoutMs || 15000;
    this.retryMax = retryMax || 5;
    this.retryBaseMs = retryBaseMs || 2000;
    this.agentVersion = require('../package.json').version;
  }

  async _request(method, path, body) {
    const url = `${this.base}/api/agent/${this.branchId}${path}`;
    const headers = {
      'X-Agent-Secret': this.agentSecret,
      'Accept': 'application/json',
      'User-Agent': `timedox-agent/${this.agentVersion}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let attempt = 0;
    let lastErr;
    while (attempt <= this.retryMax) {
      attempt++;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(t);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        if (res.ok) return data;
        // Client error → don't retry, surface to caller.
        if (res.status >= 400 && res.status < 500) {
          const err = new Error(`HTTP ${res.status}: ${(data && data.error) || text}`);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        // Server error → retry.
        lastErr = new Error(`HTTP ${res.status}: ${(data && data.error) || text}`);
        lastErr.status = res.status;
      } catch (err) {
        clearTimeout(t);
        if (err.status && err.status < 500) throw err; // non-retryable
        lastErr = err;
      }
      // Backoff before next attempt.
      if (attempt <= this.retryMax) {
        const delay = this.retryBaseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        log.warn(`request failed, retrying in ${delay}ms`, { method, path, attempt, err: lastErr && lastErr.message });
        await sleep(delay);
      }
    }
    throw lastErr || new Error('request failed after retries');
  }

  uploadPunches(punches) {
    return this._request('POST', '/punches', {
      agent_version: this.agentVersion,
      punches,
    });
  }

  heartbeat(extra = {}) {
    return this._request('POST', '/heartbeat', {
      agent_version: this.agentVersion,
      ...extra,
    });
  }

  pendingCommands(limit = 20) {
    return this._request('GET', `/pending-commands?limit=${limit}`);
  }

  commandResult(commandId, status, payload = {}) {
    return this._request('POST', '/command-result', {
      command_id: commandId,
      status,
      ...payload,
    });
  }
}

module.exports = { ServerClient };
