// ═══════════════════════════════════════════════════════════════════════════
// server.js — de webhook zelf.
//
// TradingView stuurt per bar ÉÉN bericht met een orders-array:
//   {"orders":[{...}, {...}]}
// Elke order wordt los beoordeeld, gelogd en (bij goedkeuring) doorgezet.
// Eén order die faalt laat de rest ongemoeid.
// ═══════════════════════════════════════════════════════════════════════════
import express from 'express';
import * as db from './db.js';
import * as broker from './broker.js';
import * as tracker from './tracker.js';
import {
  FIRM, TRADING_ENABLED, MAX_OPEN, MAX_RISK_TOTAL, DEFAULT_RISK_PCT,
  mapSymbol, calcLots, SPECS, firmConfig, convertToMt5, scaleLevel, MAX_BASIS_PCT,
} from './session.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET;

function authOk(req) {
  if (!SECRET) return false;
  return req.query.secret === SECRET || req.get('x-webhook-secret') === SECRET;
}

/** Alles wat er mis kan zijn met één order, vóór er iets naar de broker gaat. */
function validate(o) {
  if (!o || typeof o !== 'object')          return 'order is geen object';
  if (!['buy', 'sell'].includes(o.action))  return `action moet buy of sell zijn, kreeg "${o.action}"`;
  if (!o.symbol)                            return 'symbol ontbreekt';
  if (!o.slot_id)                           return 'slot_id ontbreekt';
  if (!(parseFloat(o.sl_points) > 0))       return `sl_points moet > 0 zijn, kreeg "${o.sl_points}"`;
  if (!(parseFloat(o.tp_points) > 0))       return `tp_points moet > 0 zijn, kreeg "${o.tp_points}"`;
  return null;
}

async function handleOrder(o) {
  const bad = validate(o);
  if (bad) {
    await db.insertSignal(FIRM, o || {}, null, 'rejected', bad);
    return { slot_id: o?.slot_id, ok: false, reason: bad };
  }

  const mt5 = mapSymbol(o.symbol);
  if (!mt5) {
    const r = `geen symboolmapping voor ${o.symbol} bij firm ${FIRM}`;
    await db.insertSignal(FIRM, o, null, 'rejected', r);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }
  if (!SPECS[mt5]) {
    const r = `geen contractspecificatie voor ${mt5}`;
    await db.insertSignal(FIRM, o, mt5, 'rejected', r);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }

  // Dubbele webhook? De unieke index op (slot_id, dag) vangt dit af.
  const sig = await db.insertSignal(FIRM, o, mt5, 'accepted', null);
  if (sig.duplicate) return { slot_id: o.slot_id, ok: false, reason: 'duplicate (slot vuurde vandaag al)' };

  // Blootstellingsremmen. Met onbeperkte houdtijd lopen open posities op, dus
  // dit is de enige rem die er is.
  const { total, n } = await db.openRiskPct();
  const riskPct = parseFloat(o.risk_pct) || DEFAULT_RISK_PCT;
  if (n >= MAX_OPEN) {
    const r = `MAX_OPEN_POSITIONS bereikt (${n}/${MAX_OPEN})`;
    await db.pool.query('UPDATE signals SET status=$2, reason=$3 WHERE id=$1', [sig.id, 'rejected', r]);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }
  if (total + riskPct > MAX_RISK_TOTAL) {
    const r = `MAX_RISK_PCT_TOTAL bereikt (${total.toFixed(2)}% + ${riskPct}% > ${MAX_RISK_TOTAL}%)`;
    await db.pool.query('UPDATE signals SET status=$2, reason=$3 WHERE id=$1', [sig.id, 'rejected', r]);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }

  if (!TRADING_ENABLED) {
    await db.pool.query('UPDATE signals SET reason=$2 WHERE id=$1', [sig.id, 'dry run — TRADING_ENABLED=false']);
    return { slot_id: o.slot_id, ok: true, dryRun: true };
  }

  // ── Futures -> CFD ───────────────────────────────────────────────────
  // Eerst de echte CFD-prijs ophalen, dan pas rekenen. De afstanden uit
  // TradingView zijn futurespunten; die worden als percentage van de
  // TV-entry overgezet en op de CFD-prijs weer in punten omgezet.
  const eq       = await broker.equity();
  const slTv     = parseFloat(o.sl_points);
  const tpTv     = parseFloat(o.tp_points);
  const entryTv  = parseFloat(o.entry) || null;

  const q   = await broker.quote(mt5);
  const ref = o.action === 'buy' ? q.ask : q.bid;
  const cv  = convertToMt5({ tvEntry: entryTv, mt5Ref: ref, slPointsTv: slTv, tpPointsTv: tpTv });

  // Sanity: staat de CFD-prijs in een heel ander bereik dan de futures, dan
  // klopt de symboolmapping niet. Beter weigeren dan verkeerd handelen.
  if (cv.scaled && Math.abs(cv.basisPct * 100) > MAX_BASIS_PCT) {
    const r = `basis ${(cv.basisPct * 100).toFixed(2)}% tussen ${o.symbol} (${entryTv}) en ` +
              `${mt5} (${ref}) overschrijdt MAX_BASIS_PCT ${MAX_BASIS_PCT}% — mapping controleren`;
    await db.pool.query('UPDATE signals SET status=$2, reason=$3 WHERE id=$1', [sig.id, 'rejected', r]);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }

  // Positiegrootte op de MT5-afstand, niet op de futures-afstand — anders zit
  // de sizing er bij Nasdaq structureel ~1,7% naast.
  const sizing = calcLots({ symbol: mt5, equity: eq, riskPct, slPoints: cv.slPointsMt5 });
  if (!sizing.lots) {
    await db.pool.query('UPDATE signals SET status=$2, reason=$3 WHERE id=$1', [sig.id, 'rejected', sizing.reason]);
    return { slot_id: o.slot_id, ok: false, reason: sizing.reason };
  }
  await db.pool.query('UPDATE signals SET sl_pct=$2, tp_pct=$3 WHERE id=$1', [sig.id, cv.slPct, cv.tpPct]);

  try {
    const res = await broker.marketOrder({
      symbol: mt5, action: o.action, volume: sizing.lots,
      slPoints: cv.slPointsMt5, tpPoints: cv.tpPointsMt5,
      comment: o.slot_id, digits: SPECS[mt5].digits, ref,
    });

    const slippage = entryTv ? +(res.fill - ref).toFixed(5) : null;

    const orderId = await db.insertOrder({
      signal_id: sig.id, firm: FIRM, slot_id: o.slot_id, mt5_symbol: mt5,
      action: o.action, volume: sizing.lots,
      entry_tv: entryTv, fill_price: res.fill, slippage,
      sl_price: res.sl, tp_price: res.tp,
      sl_points: cv.slPointsMt5, tp_points: cv.tpPointsMt5,
      sl_points_tv: slTv, tp_points_tv: tpTv,
      sl_pct: cv.slPct, tp_pct: cv.tpPct,
      basis: cv.basis, basis_pct: cv.basisPct,
      orb_high_mt5: scaleLevel(o.orb_high, cv.ratio),
      orb_low_mt5:  scaleLevel(o.orb_low,  cv.ratio),
      vwap_mt5:     scaleLevel(o.vwap,     cv.ratio),
      risk_amount: +sizing.riskAmount.toFixed(2), equity_at_open: eq,
      position_id: String(res.positionId), mt5_order_id: String(res.orderId), status: 'open',
    });

    console.log(`[Order] ${o.slot_id} ${o.action} ${mt5} ${sizing.lots} lots @ ${res.fill} ` +
                `SL ${res.sl} TP ${res.tp} | stop ${slTv}tv -> ${cv.slPointsMt5}mt5 ` +
                `(${(cv.slPct * 100).toFixed(4)}%, basis ${cv.basisPct !== null ? (cv.basisPct * 100).toFixed(2) + '%' : 'n/b'})`);
    return { slot_id: o.slot_id, ok: true, order_id: orderId, lots: sizing.lots,
             fill: res.fill, sl_points_mt5: cv.slPointsMt5 };

  } catch (e) {
    await db.logError('order', e.message, { order: o, mt5, lots: sizing.lots, conv: cv });
    await db.pool.query('UPDATE signals SET status=$2, reason=$3 WHERE id=$1', [sig.id, 'error', e.message]);
    await db.insertOrder({
      signal_id: sig.id, firm: FIRM, slot_id: o.slot_id, mt5_symbol: mt5, action: o.action,
      volume: sizing.lots, entry_tv: entryTv, fill_price: null, slippage: null,
      sl_price: null, tp_price: null, sl_points: cv.slPointsMt5, tp_points: cv.tpPointsMt5,
      sl_points_tv: slTv, tp_points_tv: tpTv, sl_pct: cv.slPct, tp_pct: cv.tpPct,
      basis: cv.basis, basis_pct: cv.basisPct,
      orb_high_mt5: null, orb_low_mt5: null, vwap_mt5: null,
      risk_amount: +sizing.riskAmount.toFixed(2), equity_at_open: eq,
      position_id: null, mt5_order_id: null, status: 'failed', error: e.message,
    });
    return { slot_id: o.slot_id, ok: false, reason: e.message };
  }
}

app.post('/webhook', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });

  // Zowel {"orders":[...]} als één losse order accepteren.
  const body   = req.body;
  const orders = Array.isArray(body?.orders) ? body.orders
               : Array.isArray(body)         ? body
               : body                        ? [body] : [];

  if (!orders.length) return res.status(400).json({ error: 'geen orders in payload' });

  const results = [];
  for (const o of orders) {
    try { results.push(await handleOrder(o)); }
    catch (e) {
      await db.logError('webhook', e.message, o);
      results.push({ slot_id: o?.slot_id, ok: false, reason: e.message });
    }
  }
  const accepted = results.filter(r => r.ok).length;
  console.log(`[Webhook] ${orders.length} order(s), ${accepted} geaccepteerd`);
  res.json({ received: orders.length, accepted, results });
});

app.get('/health', async (_req, res) => {
  try {
    const { total, n } = await db.openRiskPct();
    res.json({
      ok: true, firm: FIRM, label: firmConfig().label,
      trading: TRADING_ENABLED, broker: broker.isReady(),
      open_positions: n, open_risk_pct: total,
      limits: { max_open: MAX_OPEN, max_risk_pct: MAX_RISK_TOTAL },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/slots', async (_req, res) => {
  try { res.json(await db.slotPerformance()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (_req, res) => res.type('text').send(
  `PRONTO ORB bridge — firm=${FIRM}\n/health  /slots  POST /webhook?secret=...\n`));

(async () => {
  try {
    await db.initSchema();
    if (!SECRET) console.warn('[WAARSCHUWING] WEBHOOK_SECRET niet gezet — /webhook weigert alles');
    try {
      await broker.connect();
      const issues = await broker.verifySpecs();
      if (issues.length) {
        console.warn('[MT5] contractspecificaties wijken af van session.js:');
        issues.forEach(i => console.warn('   ' + i));
      } else {
        console.log('[MT5] contractspecificaties komen overeen met session.js');
      }
      tracker.start();
    } catch (e) {
      await db.logError('boot.broker', e.message);
      console.error('[MT5] geen verbinding — webhook logt wel, handelt niet');
    }
    app.listen(PORT, () => console.log(`[PRONTO ORB] firm=${FIRM} luistert op ${PORT}`));
  } catch (e) {
    console.error('[Boot] gefaald:', e);
    process.exit(1);
  }
})();
