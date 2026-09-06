import axios from 'axios';
import { API_ORIGIN } from './config';

/**
 * The parent portal's own HTTP client, sharing nothing with the staff one.
 *
 * api/client.js reads `localStorage.token` and attaches it to every request,
 * and on a 401 it clears that key and sends the browser to /login. Both are
 * right for staff and wrong here. A gan employee who is also a parent uses
 * one browser: with a single key the second login silently evicts the first,
 * and a parent's expired session would land on the staff login screen asking
 * for a name and an employee ID they do not have.
 *
 * So: a different storage key, a different redirect, and a token that the
 * staff API would reject anyway — the server signs the two with different
 * keys (server/src/middleware/parentAuth.js). Nothing here can be pointed at
 * a staff route by accident, and nothing there can be pointed here.
 */

export const PARENT_TOKEN_KEY = 'gan_parent_token';

const parentApi = axios.create({
  baseURL: `${API_ORIGIN}/api/parent`,
  timeout: 30000,
});

parentApi.interceptors.request.use((config) => {
  const token = localStorage.getItem(PARENT_TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

parentApi.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only an expired session should bounce. A 401 from the login screen
    // itself is "wrong password", and reloading the page over it would wipe
    // the message the parent needs to read.
    const isAuthCall = error.config?.url?.includes('/auth/');
    if (error.response?.status === 401 && !isAuthCall) {
      localStorage.removeItem(PARENT_TOKEN_KEY);
      if (window.location.pathname !== '/parents/login') {
        window.location.href = '/parents/login';
      }
    }
    return Promise.reject(error);
  }
);

/**
 * Open a file the portal serves as bytes.
 *
 * The contract route sits behind the bearer token, so an <a href> or a
 * window.open arrives with no Authorization header and gets a 401 — the file
 * simply fails to open, with nothing on screen to say why. Fetch it with the
 * token and hand the browser a blob instead.
 */
export async function openParentFile(path, fallbackName = 'document.pdf') {
  const res = await parentApi.get(path, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.download = fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a delay: released synchronously, Safari cancels the download
  // it was in the middle of starting.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * How long an upload is allowed to take.
 *
 * The default 30s is for JSON. An upload is several megabytes to the server,
 * a resize, and two writes to object storage in another country — on an
 * instance that has just woken up, comfortably more. Cut off at 30s the
 * browser reports no response at all, which surfaced as a generic "failed"
 * and hid a request that was still working.
 */
export const UPLOAD_TIMEOUT_MS = 180000;

/** The server's Hebrew message when it sent one, and something honest if not. */
export function parentApiError(err, fallback = 'שגיאה. נסו שוב.') {
  const said = err?.response?.data?.error;
  if (said) return said;

  // No response at all is a different failure from a rejected one, and saying
  // so is the difference between "try a smaller photo" and "call the gan".
  if (err?.code === 'ECONNABORTED') return 'הבקשה נקטעה. ייתכן שהקובץ גדול או שהחיבור איטי — נסו שוב.';
  if (!err?.response) return 'אין תשובה מהשרת. בדקו את החיבור ונסו שוב.';
  if (err.response.status === 413) return 'הקובץ גדול מדי.';
  return `${fallback} (שגיאה ${err.response.status})`;
}

export default parentApi;
