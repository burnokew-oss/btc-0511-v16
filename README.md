# v16 — BTC trading bot for btc-race-24h-20261123-0511

[![make.fun](https://make.fun/bounty/btc-race-24h-20261123-0511/badge)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![make.fun rank](https://make.fun/bounty/btc-race-24h-20261123-0511/rank/burnokew-oss/btc-0511-v16)](https://make.fun/bounty/btc-race-24h-20261123-0511)

A long-only CBBTC/USDC bot for the make.fun 24-hour BTC race. It starts with
1,000 USDC of paper money and trades minute by minute on the
agent-fun/bars-replay/v1 protocol (stdin/stdout, one JSON line per message).

## Strategy (three tiers, all integer math — no floats for money or prices)

- **Washout (tier 1/2):** when the 240-bar drawdown is deeper than −350 bps
  with a 2-bar up confirmation, buy 35% of cash. If price falls 100 bps
  further below entry with another 2-bar up confirmation, add with all
  remaining cash (tier 2). Exit at +190 bps, −300 bps, or 600 bars of age.
- **Dip (tier 9):** when dd240 is above −250 bps AND r60 < −115 bps AND
  RSI14 ≤ 40 AND vol60 < 13 bps AND MA240 slope ≥ −20 bps AND ADX14 ≥ 40,
  buy with all cash. Exit at +190 bps, −60 bps, 600 bars, or (age ≥ 240
  bars and pnl < +80 bps).
- **Open-buy (tier 10, new, once, bar 181):** on the batch when exactly 181
  bars have been received, if flat and r60 > −50 bps, buy with all cash.
  Exit on stop-loss −75 bps, or a 150 bps trail from the peak once the peak
  is at least +50 bps. No take-profit, no timeout — otherwise held to the
  end of the window.
- **Gradual exit (v14 tiers only):** when a v14 exit triggers, sell
  $500-worth per bar until flat instead of selling everything at once.

## Backtest (DEV window in this kit — dev numbers, not final results)

- Dev window (24 h before opening): net PnL about **+$21.43 with 2 trades**
  (one open-buy, one trail sell). Target verified with the kit's local grader.
- Four older windows (robustness, not for submission): about +$3.82 /
  +$42.84 / +$2.10 / +$2.40 — all positive, average about +$14.52.

## Run

```sh
node main.ts
```

Node 22, standard library only plus the vendored SDK shim
(`vendor/makefun-bars.ts`, a byte-for-byte copy of the kit's shim).
