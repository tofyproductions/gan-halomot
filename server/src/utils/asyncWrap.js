'use strict';

/**
 * Express 4 does not forward a rejected async handler to the error middleware.
 * A controller written as `async (req, res) => { await ... }` with no
 * try/catch therefore never answers when the await rejects: the global
 * unhandledRejection handler logs one line and the browser spins until the
 * proxy gives up. A Mongo blip turned the whole parent portal into hanging
 * sockets instead of clean 500s, and `PATCH /api/photos/not-an-objectid`
 * (CastError) could hang a request forever.
 *
 * `asyncWrap(fn)` routes both flavours of failure into next(err):
 * a synchronous throw and a rejected promise.
 *
 * `wrapControllers(mod)` wraps every exported function of a controller module
 * so a route file can guard its whole surface in one line:
 *
 *   const portal = wrapControllers(require('../controllers/parentPortal.controller'));
 *
 * The returned object is a COPY — anything importing the controller module
 * directly (services calling helper exports) still gets the originals.
 * Error middlewares (4 declared params) are left untouched: Express detects
 * them by arity, and wrapping would silently turn them into normal handlers.
 */
function asyncWrap(fn) {
  return function wrapped(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function wrapControllers(mod) {
  const out = {};
  for (const [key, value] of Object.entries(mod)) {
    out[key] = (typeof value === 'function' && value.length < 4) ? asyncWrap(value) : value;
  }
  return out;
}

module.exports = { asyncWrap, wrapControllers };
