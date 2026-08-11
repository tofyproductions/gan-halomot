/**
 * What a run of AI scanning actually cost.
 *
 * Counting how many files were scanned tells you the shape of the bill, not the
 * bill. The API reports exact token usage on every response, and the price per
 * million tokens is public — so the run log can state the cost in dollars
 * instead of leaving it to be inferred from a count and a guess.
 *
 * The prices below are Anthropic's published list rates, in dollars per million
 * tokens, and they are a CACHED COPY: they were correct on 11.08.2026 and
 * nothing here re-checks them. They exist to turn a token count into a figure a
 * person can act on — treat the result as an estimate and the invoice as the
 * authority.
 */

const PRICES = {
  // model id -> { input, output } USD per 1M tokens
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** An unknown model is priced at the most expensive tier, never at zero. */
const FALLBACK = { input: 5, output: 25 };

/** Cache reads bill at about a tenth of the input rate; writes at 1.25×. */
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

function priceFor(model) {
  return PRICES[model] || FALLBACK;
}

/**
 * Dollars for one API response.
 *
 * @param {string} model
 * @param {object} usage  the response's `usage` object
 */
function costOf(model, usage) {
  if (!usage) return 0;
  const p = priceFor(model);
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;

  return (
    (input * p.input)
    + (cacheRead * p.input * CACHE_READ_RATE)
    + (cacheWrite * p.input * CACHE_WRITE_RATE)
    + (output * p.output)
  ) / 1e6;
}

/**
 * An accumulator for one run — every call in, one total out.
 *
 * Keeps the per-model split as well as the sum, because "the gate cost this
 * much and the full read cost that much" is the number that says whether the
 * two-stage split is earning its keep.
 */
function newLedger() {
  const byModel = {};
  let total = 0;
  return {
    add(model, usage) {
      const c = costOf(model, usage);
      total += c;
      const row = byModel[model] || (byModel[model] = {
        calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0,
      });
      row.calls += 1;
      row.input_tokens += (Number(usage?.input_tokens) || 0)
        + (Number(usage?.cache_read_input_tokens) || 0)
        + (Number(usage?.cache_creation_input_tokens) || 0);
      row.output_tokens += Number(usage?.output_tokens) || 0;
      row.cost_usd += c;
      return c;
    },
    get total() { return total; },
    get breakdown() {
      return Object.entries(byModel).map(([model, r]) => ({ model, ...r }));
    },
  };
}

module.exports = { costOf, newLedger, PRICES, priceFor };
