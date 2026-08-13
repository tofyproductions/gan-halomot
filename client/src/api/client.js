import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Add auth token + branch param to requests
api.interceptors.request.use((config) => {
  // Auth token
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Auto-add branch for GET requests (unless already set)
  const branch = localStorage.getItem('selectedBranch');
  if (branch && config.method === 'get' && !config.params?.branch) {
    config.params = { ...config.params, branch };
  }

  return config;
});

// Error handling + 401 redirect
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Don't redirect if already on login page or login request
      const isLoginRequest = error.config?.url?.includes('/auth/');
      if (!isLoginRequest && window.location.pathname !== '/login') {
        localStorage.removeItem('token');
        window.location.href = '/login';
      }
    }
    console.error('API Error:', error.response?.status, error.response?.data?.error || error.message);
    return Promise.reject(error);
  }
);

/**
 * How long an upload is allowed to take.
 *
 * The default 30s is for JSON. An upload is megabytes to the server, a resize,
 * and two writes to object storage abroad — on an instance that has just woken
 * up, comfortably more. Cut off there, the browser reports no response at all,
 * which reads as "failed" while the request is in fact still working.
 */
export const UPLOAD_TIMEOUT_MS = 180000;

/**
 * What actually went wrong, in words somebody can act on.
 *
 * A rejected request and a request that never got an answer are different
 * failures, and the difference decides what to do next.
 */
export function apiError(err, fallback = 'שגיאה. נסו שוב.') {
  const said = err?.response?.data?.error;
  if (said) return said;
  if (err?.code === 'ECONNABORTED') return 'הבקשה נקטעה. ייתכן שהקובץ גדול או שהחיבור איטי — נסו שוב.';
  if (!err?.response) return 'אין תשובה מהשרת. בדקו את החיבור ונסו שוב.';
  if (err.response.status === 413) return 'הקובץ גדול מדי.';
  return `${fallback} (שגיאה ${err.response.status})`;
}

export default api;

/**
 * Open a file the API serves as bytes.
 *
 * These routes sit behind the bearer-token middleware, so an <a href> or a
 * window.open reaches them with no Authorization header and gets a 401 — the
 * file silently fails to open. Fetch it with the token and hand the browser a
 * blob instead. An absolute URL (a Google Drive link carried over from the old
 * system) is not ours to authenticate, so it opens directly.
 */
export async function openApiFile(url, { filename } = {}) {
  if (/^https?:\/\//i.test(url)) { window.open(url, '_blank', 'noopener'); return; }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || `שגיאה ${res.status}`);
  }
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = blobUrl;
  if (filename) a.download = filename; else a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}
