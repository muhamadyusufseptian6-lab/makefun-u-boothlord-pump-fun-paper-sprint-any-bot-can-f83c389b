// Petir Sniper — a pump.fun paper-trading bot for make.fun's
// "Pump.fun Paper Sprint: Any Bot Can Win" (agent-fun/replay/v2).
//
// Strategy (calibrated on the kit's dev window with a faithful replay of the
// harness — 2-slot latency, slippage, curve fees and the bot's own price
// impact — not on a frictionless backtest, which flatters momentum badly):
//   * ENTER the moment a coin first becomes buyable in size: the first time
//     its real SOL reserve crosses 1.05 SOL, so a 0.01+ SOL buy fits the
//     1%-of-real-reserve size cap. The dev data shows most of a coin's run
//     happens in the ~50 trades after it becomes buyable; entering any later
//     means buying the top through 2 slots of latency.
//   * PYRAMID into winners: add up to 3 times, each time the price has risen
//     another 15% above the last buy, sized at min(0.20 SOL, 1% of real
//     reserve). Winners pay for the losers; size follows the reserve up.
//   * EXIT with a 12% trailing stop below the peak gain (the workhorse: it
//     banks most of a run instead of giving it back), a 2.5x take-profit, a
//     0.70x hard stop, a stall exit for dead money (50+ trades without a 10%
//     gain frees the slot), and a 300-trade max hold.
//   * One entry per mint ever, at most 5 open positions, every buy >= 0.01
//     SOL so each round trip counts toward the 20-coin guardrail.
//
// Deterministic: no clock, no randomness, no network, no environment reads.
// Every decision derives from the harness state and the fixed constants
// below, so two runs on the same data produce byte-identical action logs.
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// The entry resolves its own directory from the script location, never from
// the working directory (the grader may run it from anywhere). The strategy
// itself needs no files, but the path is the anchor for any future config.
const REPO_DIR = dirname(fileURLToPath(import.meta.url));
void REPO_DIR;

// ------------------------------------------------------------------ tuning
const ENTRY_REAL_SOL = 1_050_000_000n; // 1.05 SOL of real reserve: first buyable size
const ENTRY_WINDOW_TRADES = 50; // enter within this many trades after crossing
const ENTRY_MAX_DUMP = 0.9; // ...while price holds >= 90% of the crossing price
const TARGET_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 25n) / 100n; // 0.25 SOL first buy
const PYRAMID_LAMPORTS = (LAMPORTS_PER_SOL * 20n) / 100n; // 0.20 SOL per add
const PYRAMID_STEP = 1.15; // add when price is 15% above the last buy
const MAX_ADDS = 3;
const TAKE_PROFIT = 2.5; // net gain (after sell fees) that banks the win
const TRAILING_STOP = 0.88; // sell at 12% below the peak net gain
const HARD_STOP = 0.7; // sell at 30% below the average entry cost
const STALL_TRADES = 50; // dead money: held this long without a 10% gain
const STALL_GAIN = 1.1; // ...frees the slot for the next coin
const MAX_HOLD_TRADES = 300; // free the slot when a coin goes nowhere
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's round-trip bar
const MAX_SLIPPAGE_BPS = 2000; // 20%: fills land 2 slots after the decision
const SELL_FEE_FACTOR = 0.9875; // 1 - (95 + 30) bps of curve fees on a sell
const MAX_POSITIONS = 5;

// ------------------------------------------------------------------- state
interface MintNote {
  crossTrade: number; // trades count when real reserve first crossed ENTRY_REAL_SOL
  crossPrice: number; // price (lamports per token) at that crossing
}

interface PositionNote {
  entryPrice: number; // average cost per token, fees included (lamports/token)
  peakGain: number; // best net gain seen since entry
  lastBuyPrice: number; // market price at the most recent buy fill
  entryTrade: number; // trades count on the mint when the first buy filled
  adds: number; // pyramid buys filled so far
}

const notes = new Map<string, MintNote>();
const entered = new Set<string>();
const positions = new Map<string, PositionNote>();

function priceOf(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

/** Net gain of a position at the given market price, after sell curve fees. */
function netGain(price: number, entryPrice: number): number {
  if (entryPrice <= 0 || price <= 0) return 0;
  return (price * SELL_FEE_FACTOR) / entryPrice;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    // --- fold this batch's fills into the strategy's own books ------------
    for (const fill of batch.fills) {
      if (fill.client_id.startsWith('_')) {
        // A harness close (complete / flatten / write-off): the position is
        // gone; drop the note so it is never traded again (entered stays set).
        positions.delete(fill.mint);
        continue;
      }
      if (fill.status === 'filled' && fill.side === 'buy') {
        const curve = state.curves.get(fill.mint);
        const spent = BigInt(fill.quote_lamports);
        const tokens = BigInt(fill.token_amount);
        if (tokens === 0n) continue;
        const marketPrice = curve ? priceOf(curve) : Number(spent) / Number(tokens);
        const note = positions.get(fill.mint);
        if (note === undefined) {
          positions.set(fill.mint, {
            entryPrice: Number(spent) / Number(tokens),
            peakGain: netGain(marketPrice, Number(spent) / Number(tokens)),
            lastBuyPrice: marketPrice,
            entryTrade: curve ? curve.trades : 0,
            adds: 0,
          });
          entered.add(fill.mint);
        } else {
          // Pyramid add: re-average the cost per token over all tokens held.
          const held = state.positions.get(fill.mint);
          const heldTokens = held ? held.token_amount : tokens;
          const prevTokens = heldTokens - tokens;
          const prevCost = prevTokens > 0n ? BigInt(Math.round(note.entryPrice * Number(prevTokens))) : 0n;
          note.entryPrice = Number(prevCost + spent) / Number(heldTokens);
          note.lastBuyPrice = marketPrice;
          note.adds += 1;
          note.peakGain = Math.max(note.peakGain, netGain(marketPrice, note.entryPrice));
        }
      } else if (fill.status === 'filled' && fill.side === 'sell') {
        // A sell that filled: if nothing is held any more, the note is done.
        if (!state.positions.has(fill.mint)) positions.delete(fill.mint);
      }
      // Rejected / failed orders leave the books untouched: the position (if
      // any) is still held and the mint may be retried within its window.
    }
    // A position the harness flattened without a fill we saw (or that vanished
    // for any other reason) must not be traded as if still held.
    for (const mint of [...positions.keys()]) {
      if (!state.positions.has(mint)) positions.delete(mint);
    }

    const pendingBuy = new Set<string>();
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
      else pendingSell.add(p.order.mint);
    }

    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // --- exits and pyramids for everything held ---------------------------
    for (const [mint, holding] of state.positions) {
      const note = positions.get(mint);
      const curve = state.curves.get(mint);
      if (note === undefined || curve === undefined || curve.complete) continue;
      const price = priceOf(curve);
      if (price <= 0) continue;
      const gain = netGain(price, note.entryPrice);
      if (gain > note.peakGain) note.peakGain = gain;
      const heldTrades = curve.trades - note.entryTrade;

      const wantExit =
        gain >= TAKE_PROFIT ||
        gain <= note.peakGain * TRAILING_STOP ||
        gain <= HARD_STOP ||
        (heldTrades >= STALL_TRADES && gain < STALL_GAIN) ||
        heldTrades >= MAX_HOLD_TRADES;
      if (wantExit) {
        if (!pendingSell.has(mint)) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      // Pyramid: the coin is still running and no buy is in flight.
      if (
        note.adds < MAX_ADDS &&
        price >= note.lastBuyPrice * PYRAMID_STEP &&
        !pendingBuy.has(mint)
      ) {
        const size = [PYRAMID_LAMPORTS, state.maxBuyLamports(mint), state.freeCashLamports() - 2n * txFee]
          .reduce((a, b) => (a < b ? a : b));
        if (size >= MIN_BUY_LAMPORTS) {
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }

    // --- entries: only mints that traded in this batch can cross ---------
    const seen = new Set<string>();
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent' || seen.has(event.mint)) continue;
      seen.add(event.mint);
      const mint = event.mint;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (entered.has(mint) || state.positions.has(mint) || pendingBuy.has(mint)) continue;
      if (state.committedPositionCount() >= MAX_POSITIONS) continue;

      const price = priceOf(curve);
      if (price <= 0) continue;
      let note = notes.get(mint);
      if (note === undefined) {
        note = { crossTrade: -1, crossPrice: 0 };
        notes.set(mint, note);
      }
      if (note.crossTrade === -1 && curve.real_quote_reserves >= ENTRY_REAL_SOL) {
        note.crossTrade = curve.trades;
        note.crossPrice = price;
      }
      if (note.crossTrade === -1) continue;
      if (curve.trades - note.crossTrade > ENTRY_WINDOW_TRADES) continue;
      if (price < note.crossPrice * ENTRY_MAX_DUMP) continue;

      const size = [TARGET_BUY_LAMPORTS, state.maxBuyLamports(mint), state.freeCashLamports() - 2n * txFee]
        .reduce((a, b) => (a < b ? a : b));
      if (size < MIN_BUY_LAMPORTS) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    // The harness caps replies at max_orders_per_batch; exits come first.
    return orders.slice(0, state.hello.caps.max_orders_per_batch);
  },
});
