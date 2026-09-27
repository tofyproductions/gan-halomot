'use strict';

/**
 * Call an existing Express handler from inside another one, and get its answer
 * back instead of sending it. The manager's follow-up window acts ONLY through
 * the handlers that already guard these writes (approvePunch, rejectPunch,
 * resolvePunchDay, createManualPunches) — so scope checks, the manager-first
 * rule, dedupe and notifications each keep living in exactly one place.
 *
 * Object.create keeps the caller's user / headers / get() on the prototype
 * while params, body and query are replaced — the original req is untouched.
 */
function invoke(handler, req, { params = {}, body = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const sub = Object.create(req);
    sub.params = params;
    sub.body = body;
    sub.query = query;
    let status = 200;
    const res = {
      status(code) { status = code; return res; },
      json(payload) { resolve({ status, body: payload }); return res; },
      send(payload) { resolve({ status, body: payload }); return res; },
      setHeader() { return res; },
    };
    Promise.resolve(handler(sub, res, reject)).catch(reject);
  });
}

module.exports = { invoke };
