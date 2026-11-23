// v16 — bot BTC untuk btc-race-24h-20261123-0511.
//
// Strategi (tiga tier, long only, satu posisi):
//   - Tier v14 washout (tahap 1/2): beli saat drawdown 240 bar sangat dalam
//     (dd240 < -350 bps) dengan konfirmasi naik 2 bar; kaki tambah bila turun
//     100 bps lagi dari entry. Exit TP +190 / SL -300 / umur 600 bar.
//   - Tier v14 dip (tahap 9): beli saat dd240 > -250 bps DAN r60 < -115 bps
//     DAN RSI14 <= 40 DAN vol60 < 13 bps DAN slope MA240 >= -20 bps DAN
//     ADX14 >= 40. Exit TP +190 / SL -60 / umur 600 / (umur >= 240 dan
//     pnl < +80 bps).
//   - Tier open-buy (baru, satu kali, bar ke-181): beli full bila r60 > -50
//     bps; exit SL -75 bps atau trail 150 bps dari puncak (puncak >= +50).
//   - Exit tier v14 bertahap: jual kuantitas senilai 500 USDC per bar.
// Semua uang/harga bilangan bulat (bigint); semua perbandingan lewat
// perkalian silang. Deterministik: tanpa jam, network, file, atau random.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10000n;
const ONE_USDC = 1000000n; // 1 USDC dalam quote units (skala 1e6)
const MAX_SLIPPAGE_BPS = 200;
const SCALE7 = 10n ** 7n; // qty (1e8) * harga (1e5) / 1e7 = nilai USDC (1e6)

// --- keadaan yang dilacak -------------------------------------------------
const closes: bigint[] = [];
const highs: bigint[] = [];
const lows: bigint[] = [];
// Jumlah bergulir 240 close terakhir, sejajar indeks bar (bermakna bila i>=239).
const sums240: bigint[] = [];
let rollSum240 = 0n;

// Keadaan ADX14 Wilder (semua nilai berskala 100*10000 untuk DI/DX/ADX).
let smTR = 0n;
let smPlus = 0n;
let smMinus = 0n;
let adx = 0n; // 0 sebelum bar 14

// Tier posisi: 0 flat, 1 washout tahap 1, 2 washout tahap 2, 9 dip, 10 open-buy.
let tier = 0;
let entryPrice = 0n; // close saat keputusan beli
let entryBar = 0; // jumlah bar diterima saat keputusan beli
// Tier yang menunggu adopsi (posisi baru tampak di akun pada batch berikut).
let pendingTier = 0;
let pendingEntryPrice = 0n;
let pendingEntryBar = 0;
let exiting = false; // flag gradual exit tier v14
let openBuyUsed = false; // tier open-buy sudah dipakai / hangus
let peakValue = 0n; // nilai posisi tertinggi sejak entry (tier open-buy)

// --- util ------------------------------------------------------------------
function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// Nilai posisi (quote units) dari qty pada close sekarang.
function positionValue(qty: bigint, close: bigint): bigint {
  return (qty * close) / SCALE7;
}

// --- fitur -----------------------------------------------------------------
function r60BelowMinus115(): boolean {
  const i = closes.length - 1;
  if (i < 60) return false; // r60 = 0 bps bila data belum cukup
  return closes[i]! * BPS < closes[i - 60]! * 9885n;
}

function r60AboveMinus50(): boolean {
  const i = closes.length - 1;
  if (i < 60) return true; // r60 = 0 bps > -50 bps bila data belum cukup
  return closes[i]! * BPS > closes[i - 60]! * 9950n;
}

function dd240High(): bigint {
  const i = closes.length - 1;
  const start = Math.max(0, i - 239);
  let high = closes[start]!;
  for (let j = start + 1; j <= i; j++) {
    if (closes[j]! > high) high = closes[j]!;
  }
  return high;
}

function dd240BelowMinus350(): boolean {
  const i = closes.length - 1;
  return closes[i]! * BPS < dd240High() * 9650n;
}

function dd240AboveMinus250(): boolean {
  const i = closes.length - 1;
  return closes[i]! * BPS > dd240High() * 9750n;
}

function rsi14Le40(): boolean {
  const i = closes.length - 1;
  if (i < 14) return false;
  let gains = 0n;
  let losses = 0n;
  for (let j = i - 13; j <= i; j++) {
    const d = closes[j]! - closes[j - 1]!;
    if (d > 0n) gains += d;
    else if (d < 0n) losses += -d;
  }
  if (losses === 0n) return false; // RSI dianggap 100
  return 3n * gains <= 2n * losses;
}

// Volatilitas 60 bar, simpangan baku populasi return 1-menit, hasil berskala
// 10000 (jadi "vol60 < 13 bps" berarti hasil < 13 * 10000).
function vol60Scaled(): bigint {
  const i = closes.length - 1;
  if (i < 60) return 0n;
  const rets: bigint[] = [];
  let sum = 0n;
  for (let j = i - 59; j <= i; j++) {
    const r = ((closes[j]! - closes[j - 1]!) * BPS * BPS) / closes[j - 1]!;
    rets.push(r);
    sum += r;
  }
  const mean = sum / 60n;
  let varSum = 0n;
  for (const r of rets) {
    const d = r - mean;
    varSum += d * d;
  }
  return isqrt(varSum / 60n);
}

function vol60Lt13(): boolean {
  return vol60Scaled() < 13n * BPS;
}

// Slope MA240, berskala 10000 (0 bila baru kurang dari 300 bar).
function slope240Scaled(): bigint {
  const i = closes.length - 1;
  if (i < 299) return 0n;
  const now = sums240[i]!;
  const ago = sums240[i - 60]!;
  return (BPS * BPS * (now - ago)) / ago;
}

function slope240GeMinus20(): boolean {
  return slope240Scaled() >= -20n * BPS;
}

function computeDx(): bigint {
  if (smTR <= 0n) return 0n;
  const diPlus = (100n * BPS * smPlus) / smTR;
  const diMinus = (100n * BPS * smMinus) / smTR;
  const sum = diPlus + diMinus;
  if (sum === 0n) return 0n;
  const diff = diPlus >= diMinus ? diPlus - diMinus : diMinus - diPlus;
  return (100n * BPS * diff) / sum;
}

// Perbarui keadaan ADX14 untuk bar yang baru diterima (indeks i).
function updateAdx(): void {
  const i = closes.length - 1;
  if (i < 1) return;
  const upMove = highs[i]! - highs[i - 1]!;
  const downMove = lows[i - 1]! - lows[i]!;
  const plusDM = upMove > downMove && upMove > 0n ? upMove : 0n;
  const minusDM = downMove > upMove && downMove > 0n ? downMove : 0n;
  const tr1 = highs[i]! - lows[i]!;
  const tr2 = highs[i]! - closes[i - 1]!;
  const tr2a = tr2 >= 0n ? tr2 : -tr2;
  const tr3 = closes[i - 1]! - lows[i]!;
  const tr3a = tr3 >= 0n ? tr3 : -tr3;
  const tr = tr1 > tr2a ? (tr1 > tr3a ? tr1 : tr3a) : (tr2a > tr3a ? tr2a : tr3a);
  if (i <= 14) {
    smTR += tr;
    smPlus += plusDM;
    smMinus += minusDM;
    if (i === 14) adx = computeDx();
  } else {
    smTR = smTR - smTR / 14n + tr;
    smPlus = smPlus - smPlus / 14n + plusDM;
    smMinus = smMinus - smMinus / 14n + minusDM;
    const dx = computeDx();
    adx = (adx * 13n + dx) / 14n;
  }
}

function adx14Ge40(): boolean {
  return adx >= 40n * BPS;
}

// Konfirmasi naik 2 bar: close sekarang > close 2 bar lalu.
function up2Bars(): boolean {
  const i = closes.length - 1;
  if (i < 2) return false;
  return closes[i]! > closes[i - 2]!;
}

// --- perbandingan pnl (perkalian silang) -----------------------------------
function pnlGe(value: bigint, cost: bigint, tpBps: bigint): boolean {
  return value * BPS >= cost * (BPS + tpBps);
}

function pnlLe(value: bigint, cost: bigint, slBps: bigint): boolean {
  return value * BPS <= cost * (BPS - slBps);
}

function pnlLt(value: bigint, cost: bigint, tpBps: bigint): boolean {
  return value * BPS < cost * (BPS + tpBps);
}

// --- order -----------------------------------------------------------------
function buyOrder(notional: bigint): OrderInput {
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellOrder(qty: bigint): OrderInput {
  return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

// Kuantitas senilai 500 USDC pada close sekarang (gradual exit tier v14).
function chunk500Qty(close: bigint, held: bigint): bigint {
  if (close <= 0n) return held;
  const q = (500n * 10n ** 13n) / close;
  if (q <= 0n) return held;
  return q > held ? held : q;
}

// --- loop utama --------------------------------------------------------------
async function main(): Promise<void> {
  await runBars({
    onBatch(state: BarsState, batch: Batch): OrderInput[] {
      const bar = batch.bars.find((b) => b.symbol === SYMBOL);
      if (bar === undefined) return [];
      const close = BigInt(bar.c);
      closes.push(close);
      highs.push(BigInt(bar.h));
      lows.push(BigInt(bar.l));
      rollSum240 += close;
      if (closes.length > 240) rollSum240 -= closes[closes.length - 241]!;
      sums240.push(rollSum240);
      updateAdx();

      const n = closes.length; // jumlah bar diterima (bar ke-181 berarti n == 181)
      const cash = state.cash;
      const pos = state.positions.get(SYMBOL);
      const qty = pos === undefined ? 0n : pos.qty;
      const cost = pos === undefined ? 0n : pos.cost;

      // Adopsi tier pending begitu posisi tampak di akun; reset bila flat.
      if (qty > 0n) {
        if (pendingTier !== 0) {
          tier = pendingTier;
          entryPrice = pendingEntryPrice;
          entryBar = pendingEntryBar;
          pendingTier = 0;
          peakValue = 0n;
        }
      } else {
        tier = 0;
        exiting = false;
        peakValue = 0n;
      }

      const value = positionValue(qty, close);
      const age = n - entryBar;

      // --- sedang memegang posisi -------------------------------------------
      if (qty > 0n) {
        // Bar ke-181 sambil memegang posisi: tier open-buy hangus selamanya.
        if (n === 181 && !openBuyUsed) openBuyUsed = true;

        // Gradual exit tier v14: terus jual 500 USDC per bar sampai flat.
        if (exiting) return [sellOrder(chunk500Qty(close, qty))];

        if (tier === 10) {
          // Tier open-buy: lacak puncak, exit SL -75 atau trail 150 dari puncak.
          if (value > peakValue) peakValue = value;
          if (pnlLe(value, cost, 75n)) return [sellOrder(qty)];
          // Puncak >= +50 bps DAN nilai sekarang turun 150 bps dari puncak.
          if (peakValue * BPS >= cost * 10050n && value * BPS <= peakValue * 9850n) return [sellOrder(qty)];
          return [];
        }

        if (tier === 1 || tier === 2) {
          // Exit washout: TP +190 / SL -300 / umur 600 -> mulai gradual exit.
          if (pnlGe(value, cost, 190n) || pnlLe(value, cost, 300n) || age >= 600) {
            exiting = true;
            return [sellOrder(chunk500Qty(close, qty))];
          }
          // Kaki tambah washout tahap 2: turun 100 bps lagi dari entry +
          // konfirmasi naik 2 bar, beli dengan seluruh sisa kas.
          if (tier === 1 && cash >= ONE_USDC && close * BPS < entryPrice * 9900n && up2Bars()) {
            tier = 2;
            return [buyOrder(cash)];
          }
          return [];
        }

        if (tier === 9) {
          // Exit dip: TP +190 / SL -60 / umur 600 / (umur >= 240 dan pnl < +80).
          if (
            pnlGe(value, cost, 190n) ||
            pnlLe(value, cost, 60n) ||
            age >= 600 ||
            (age >= 240 && pnlLt(value, cost, 80n))
          ) {
            exiting = true;
            return [sellOrder(chunk500Qty(close, qty))];
          }
          return [];
        }

        return []; // posisi tanpa tier: pegang
      }

      // --- sedang flat --------------------------------------------------------
      // Tier v14 hanya bila sudah menerima lebih dari 240 bar.
      if (n >= 241) {
        // Washout tahap 1 dulu, lalu dip.
        if (dd240BelowMinus350() && up2Bars()) {
          const amount = (cash * 3500n) / BPS;
          if (amount >= ONE_USDC) {
            pendingTier = 1;
            pendingEntryPrice = close;
            pendingEntryBar = n;
            return [buyOrder(amount)];
          }
        }
        if (
          dd240AboveMinus250() &&
          r60BelowMinus115() &&
          rsi14Le40() &&
          vol60Lt13() &&
          slope240GeMinus20() &&
          adx14Ge40()
        ) {
          if (cash >= ONE_USDC) {
            pendingTier = 9;
            pendingEntryPrice = close;
            pendingEntryBar = n;
            return [buyOrder(cash)];
          }
        }
      }

      // Tier open-buy: hanya pada batch saat jumlah bar diterima tepat 181.
      if (n === 181 && !openBuyUsed) {
        openBuyUsed = true; // sekali pakai: berhasil atau hangus
        if (r60AboveMinus50() && cash >= ONE_USDC) {
          pendingTier = 10;
          pendingEntryPrice = close;
          pendingEntryBar = n;
          return [buyOrder(cash)];
        }
      }

      return [];
    },
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
