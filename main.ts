// Tiny momentum-rotation bot for agent-fun/bars-replay/v1 (hourly Solana bars).
//
// Idea: buy-and-hold loses whenever the 3-day final window drifts down, and a
// plain trend filter loses whenever it drifts up. So this bot holds only the
// strongest symbols whose own trend is up, and sits in USDC otherwise:
//   - Per symbol: EMA(6) vs EMA(18) on closes, plus 12-bar momentum.
//   - A symbol is "in trend" when EMA(6) > EMA(18), close > EMA(18) and its
//     12-bar return is positive.
//   - It holds the top 4 in-trend symbols by momentum, each sized at the 25%
//     weight cap, so a broad uptrend is fully invested in the leaders.
//     Entries happen as soon as a leader qualifies; exits use hysteresis
//     (EMA(6) < EMA(18), without the momentum condition) plus a -6% stop,
//     so a one-bar momentum dip does not churn the book. If fewer than 8
//     orders have been sent by scored bar 30, it makes small rotation trades
//     in the least-weak symbol so the trade-count guardrail cannot fail on a
//     quiet window.
//   - In a broad downtrend nothing is in trend, so the bot holds cash and
//     beats buy-and-hold by not losing; in an uptrend it is invested in the
//     leaders. Rotation guarantees regular trades for the >=8-trade guardrail.
// Deterministic: float math on bar closes only, no clock, no randomness.

import { BPS, runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST = 6;
const SLOW = 18;
const MOM_BARS = 12;
const TOP_K = 4;
const STOP_BPS = 600n; // exit at -6% versus cost
const MAX_SLIPPAGE_BPS = 250;
const MIN_ORDERS = 8;
const MIN_ORDER_DEADLINE_BAR = 30;

interface Series {
  closes: number[];
  fast: number | null;
  slow: number | null;
  fastWarm: number[];
  slowWarm: number[];
}

const series = new Map<string, Series>();
let scoredBars = 0;
let ordersSent = 0;

function emaStep(warm: number[], value: number | null, span: number, close: number): number | null {
  if (value !== null) return value + (2 / (span + 1)) * (close - value);
  warm.push(close);
  if (warm.length === span) return warm.reduce((a, x) => a + x, 0) / span;
  return null;
}

function push(bar: Bar): void {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { closes: [], fast: null, slow: null, fastWarm: [], slowWarm: [] };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  s.closes.push(c);
  if (s.closes.length > 64) s.closes.shift();
  s.fast = emaStep(s.fastWarm, s.fast, FAST, c);
  s.slow = emaStep(s.slowWarm, s.slow, SLOW, c);
}

function momentum(s: Series): number | null {
  if (s.closes.length <= MOM_BARS) return null;
  const past = s.closes[s.closes.length - 1 - MOM_BARS];
  if (past === 0) return null;
  return s.closes[s.closes.length - 1] / past - 1;
}

function inTrend(s: Series): boolean {
  const m = momentum(s);
  if (s.fast === null || s.slow === null || m === null) return false;
  const last = s.closes[s.closes.length - 1];
  return s.fast > s.slow && last > s.slow && m > 0;
}

/** Exit-side trend break, with hysteresis: no momentum condition. */
function trendBroken(s: Series): boolean {
  if (s.fast === null || s.slow === null) return false;
  return s.fast < s.slow;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];
    scoredBars++;

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];

    // Immediate exits: trend broken or stop hit.
    const stoppedOrBroken = new Set<string>();
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held === undefined) continue;
      const s = series.get(symbol);
      const value = state.value(symbol, held.qty);
      const stopped = value * BPS <= held.cost * (BPS - STOP_BPS);
      if (stopped || s === undefined || trendBroken(s)) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        stoppedOrBroken.add(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);

    // Entries: fill any empty leader slot as soon as a symbol qualifies.
    const ranked = state.hello.symbols
      .map(({ symbol }) => ({ symbol, s: series.get(symbol) }))
      .filter((x) => x.s !== undefined && inTrend(x.s))
      .sort((a, b) => (momentum(b.s!) ?? 0) - (momentum(a.s!) ?? 0))
      .slice(0, TOP_K)
      .map((x) => x.symbol);

    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let cash = state.cash;
    let heldCount = state.positions.size - stoppedOrBroken.size;
    for (const symbol of ranked) {
      if (orders.length >= caps.max_orders_per_bar || heldCount >= TOP_K) break;
      if (state.positions.has(symbol)) continue;
      let slice = byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      heldCount++;
    }

    // Trade-count floor: on a quiet window, rotate a small slice through the
    // least-weak symbol (best momentum, trend or not) so the guardrail's
    // minimum trade count is met without betting the book on it.
    if (ordersSent + orders.length < MIN_ORDERS && scoredBars >= MIN_ORDER_DEADLINE_BAR && orders.length < caps.max_orders_per_bar) {
      const best = state.hello.symbols
        .map(({ symbol }) => ({ symbol, s: series.get(symbol) }))
        .filter((x) => x.s !== undefined && momentum(x.s) !== null)
        .sort((a, b) => (momentum(b.s!) ?? 0) - (momentum(a.s!) ?? 0))[0];
      if (best !== undefined) {
        const held = state.positions.get(best.symbol);
        if (held !== undefined && !stoppedOrBroken.has(best.symbol)) {
          orders.push({ side: 'sell', symbol: best.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        } else if (held === undefined) {
          const slice = state.equity / 20n;
          if (slice >= BigInt(fees.min_notional_quote_units) && cash >= slice) {
            orders.push({ side: 'buy', symbol: best.symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      }
    }

    ordersSent += orders.length;
    return orders;
  },
});
