[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/muhamadyusufseptian6-lab/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/muhamadyusufseptian6-lab/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Petir Sniper — Pump.fun Paper Sprint Bot

A paper-trading bot for make.fun's **Pump.fun Paper Sprint: Any Bot Can Win**.
It replays 6 hours of real pump.fun market data; the highest net PnL wins.
No real money, no entry fee — pure paper trading.

## The idea

Most pump.fun coins pump fast, then dump. The money is in catching the pump
early and banking it before the dump — not in predicting which coin moons.

- **Enter at proof of demand.** The bot buys the moment a coin's real SOL
  reserve first crosses 1.05 SOL — and only within the next 50 trades, while
  the price still holds at least 90% of the crossing price. By then a 0.01+
  SOL buy fits the 1% size cap, and the coin is still early: on the dev
  window, most of a coin's run happens in the ~50 trades after it becomes
  buyable. Entering later means buying the top through 2 slots of latency.
  First buy targets 0.25 SOL.
- **Pyramid into winners.** Up to 3 adds, each time the price rises another
  15% above the last buy, sized at min(0.20 SOL, 1% of the coin's real
  reserve). Winners pay for the losers; size follows the reserve up.
- **Exit with a trailing stop.** A 12% pullback from the peak net gain (after
  sell fees) banks the run instead of giving it back. A 2.5x take-profit, a
  0.70x hard stop, a stall exit for dead money (50+ trades without a 10%
  gain), and a 300-trade max hold free dead slots.

One entry per mint, at most 5 open positions, every buy ≥ 0.01 SOL so each
round trip counts toward the 20-coin guardrail.

## How it works

- `main.ts` (Node 22, stdlib-only) speaks `agent-fun/replay/v2` on
  stdin/stdout through the kit's shim in `vendor/makefun-bot.ts`.
- Fully deterministic: no clock, no randomness, no network, no environment
  reads. Two runs on the same data produce byte-identical action logs.
- Paper capital 10 SOL, max 5 open positions, no shorts, no leverage.

## Local check

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Referral

Built with make.fun — try it with referral code **515temp1**.
