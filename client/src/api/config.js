/**
 * The web build talks to the API on the same origin (relative paths), and
 * stays that way by default. The native shell (Capacitor) has no origin of
 * its own to be same-origin with — capacitor://localhost / https://localhost
 * serve the bundled files, not the API — so it needs an absolute host.
 *
 * One env var controls both: unset, everything below is a plain '' prefix
 * and behavior is identical to before this file existed.
 */
export const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

/** Prefix a server-relative path (e.g. '/api/documents/9/download') for fetch() calls that bypass axios. */
export function apiUrl(path) {
  return `${API_ORIGIN}${path}`;
}
