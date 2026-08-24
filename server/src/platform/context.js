/**
 * Which customer the code running right now belongs to.
 *
 * THE PROBLEM THIS SOLVES. 58 controllers open with a line like
 *
 *     const { Child, Registration } = require('../models');
 *
 * and that line runs once, when the file is first loaded — long before any
 * request exists. Handing a controller `req.models` therefore means editing
 * every one of those files, and every file that got missed is one gan reading
 * another gan's children. Nobody reviews 58 controllers well enough to bet
 * other people's children on it.
 *
 * So the models stay exactly where they are and change underneath. The store
 * below carries the current request's models; `src/models` exports objects that
 * look up the answer at the moment a query is made rather than at import time.
 *
 * WITH NO PLATFORM_MONGODB_URI NONE OF THIS EXISTS. `src/models` exports the
 * real models on the ordinary connection and this file is never consulted, so
 * גן החלומות runs on the code it has always run on.
 *
 * A request that reaches a query with no customer in the store is a bug, and it
 * FAILS rather than quietly reading the default database. That is the whole
 * point: silently serving the wrong gan's data is the failure worth making
 * impossible, and an exception in a log is the cheap version of it.
 */

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/** True only when this process is a control plane. Read from the environment
 *  directly — requiring connection.js here would be circular through models. */
function platformMode() {
  return Boolean(process.env.PLATFORM_MONGODB_URI);
}

/** Run `fn` with `models` as the current customer's models. */
function runWith(models, fn) {
  return store.run(models, fn);
}

/** The current customer's models, or null outside a request. */
function currentModels() {
  return store.getStore() || null;
}

module.exports = { platformMode, runWith, currentModels };
