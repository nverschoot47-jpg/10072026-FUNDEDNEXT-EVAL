// ═══════════════════════════════════════════════════════════════════════════
// server.js — de webhook zelf.
//
// TradingView stuurt per bar ÉÉN bericht met een orders-array:
//   {"orders":[{...}, {...}]}
// Elke order wordt los beoordeeld, gelogd en (bij goedkeuring) doorgezet.
// Eén order die faalt laat de rest ongemoeid.
//
// HANDELSPAD ONGEWIJZIGD. Alleen het leespad (dashboard + JSON-API) is nieuw:
// het dashboard is nu clientside en toont élk veld uit de PineScript-payload,
// omgerekend naar MT5-schaal en uitgedrukt als percentage van de MT5-entry.
// ═══════════════════════════════════════════════════════════════════════════
import express from 'express';
import * as db from './db.js';
import * as broker from './broker.js';
import * as tracker from './tracker.js';
import * as guard from './guard.js';
import {
  FIRM, TRADING_ENABLED, MAX_OPEN, MAX_RISK_TOTAL, DEFAULT_RISK_PCT,
  mapSymbol, calcLots, SPECS, firmConfig, convertToMt5, scaleLevel, MAX_BASIS_PCT,
  resolveRiskPct, RISK_OVERRIDE,
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

  // ── Circuit breaker ─────────────────────────────────────────────────
  const brk = await guard.status();
  if (brk.tripped) {
    const r = `circuit breaker actief: ${brk.reason}`;
    await db.insertSignal(FIRM, o, mt5, 'rejected', r);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }

  // ── Broker bereikbaar? ──────────────────────────────────────────────
  // Dit stond vroeger ná de accepted-insert. Gevolg: bij een brokerstoring
  // bleef het signaal als 'accepted' staan, bezette het de dag-index, en kon
  // hetzelfde slot die dag niet meer vuren. Nu weigeren we vóór de insert,
  // zodat een herhaalde webhook alsnog door kan.
  if (!broker.isReady()) {
    const r = `broker niet verbonden: ${broker.lastError() || 'onbekende reden'}`;
    await db.insertSignal(FIRM, o, mt5, 'rejected', r);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }

  // Dubbele webhook? De unieke index op (slot_id, dag) vangt dit af.
  o.__account = broker.accountId();
  const sig = await db.insertSignal(FIRM, o, mt5, 'accepted', null);
  if (sig.duplicate) return { slot_id: o.slot_id, ok: false, reason: 'duplicate (slot vuurde vandaag al)' };

  const { total, n } = await db.openRiskPct();
  const { pct: riskPct, bron: riskBron } = resolveRiskPct(o.risk_pct);
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
  const eq       = await broker.equity();
  const slTv     = parseFloat(o.sl_points);
  const tpTv     = parseFloat(o.tp_points);
  const entryTv  = parseFloat(o.entry) || null;

  const q   = await broker.quote(mt5);
  const ref = o.action === 'buy' ? q.ask : q.bid;
  const cv  = convertToMt5({ tvEntry: entryTv, mt5Ref: ref, slPointsTv: slTv, tpPointsTv: tpTv });

  if (cv.scaled && Math.abs(cv.basisPct * 100) > MAX_BASIS_PCT) {
    const r = `basis ${(cv.basisPct * 100).toFixed(2)}% tussen ${o.symbol} (${entryTv}) en ` +
              `${mt5} (${ref}) overschrijdt MAX_BASIS_PCT ${MAX_BASIS_PCT}% — mapping controleren`;
    await db.pool.query('UPDATE signals SET status=$2, reason=$3 WHERE id=$1', [sig.id, 'rejected', r]);
    return { slot_id: o.slot_id, ok: false, reason: r };
  }

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

    const dq = guard.checkData(o, { conversieGeschaald: cv.scaled, basisPct: cv.basisPct });

    const orderId = await db.insertOrder({
      signal_id: sig.id, firm: FIRM, slot_id: o.slot_id, mt5_symbol: mt5,
      account_id: broker.accountId(),
      valid: dq.valid, invalid_reason: dq.valid ? null : dq.reasons.join('; '),
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

    if (!dq.valid) console.warn(`[Data] ${o.slot_id} gemarkeerd als INVALID — ${dq.reasons.join('; ')}`);
    console.log(`[Order] ${o.slot_id} ${o.action} ${mt5} ${sizing.lots} lots @ ${res.fill} ` +
                `SL ${res.sl} TP ${res.tp} | risk ${riskPct}% (${riskBron}) | stop ${slTv}tv -> ${cv.slPointsMt5}mt5 ` +
                `(${(cv.slPct * 100).toFixed(4)}%, basis ${cv.basisPct !== null ? (cv.basisPct * 100).toFixed(2) + '%' : 'n/b'})`);
    return { slot_id: o.slot_id, ok: true, order_id: orderId, lots: sizing.lots,
             fill: res.fill, sl_points_mt5: cv.slPointsMt5 };

  } catch (e) {
    await db.logError('order', e.message, { order: o, mt5, lots: sizing.lots, conv: cv });
    await db.pool.query('UPDATE signals SET status=$2, reason=$3 WHERE id=$1', [sig.id, 'error', e.message]);
    await db.insertOrder({
      signal_id: sig.id, firm: FIRM, slot_id: o.slot_id, mt5_symbol: mt5, action: o.action,
      account_id: broker.accountId(),
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
      try {
        await db.pool.query(
          `INSERT INTO signals (firm, slot_id, action, tv_symbol, status, reason, raw)
           VALUES ($1,$2,$3,$4,'error',$5,$6)`,
          [FIRM, o?.slot_id ?? 'onbekend', o?.action ?? null, o?.symbol ?? null,
           e.message.slice(0, 500), JSON.stringify(o ?? {})]);
      } catch { /* database zelf onbereikbaar; errors-tabel heeft het al */ }
      results.push({ slot_id: o?.slot_id, ok: false, reason: e.message });
    }
  }
  const accepted = results.filter(r => r.ok).length;
  console.log(`[Webhook] ${orders.length} order(s), ${accepted} geaccepteerd`);
  res.json({ received: orders.length, accepted, results });
});

// ── Bestaande JSON-routes, ongewijzigd ───────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const { total, n } = await db.openRiskPct();
    res.json({
      ok: true, firm: FIRM, label: firmConfig().label,
      trading: TRADING_ENABLED, broker: broker.isReady(),
      broker_error: broker.isReady() ? null : broker.lastError(),
      account: broker.accountId(),
      open_positions: n, open_risk_pct: total,
      limits: { max_open: MAX_OPEN, max_risk_pct: MAX_RISK_TOTAL },
      risk_per_trade: RISK_OVERRIDE !== null ? `${RISK_OVERRIDE}% (override)` : 'uit de webhook',
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/reconnect', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const info = await broker.reconnect();
    res.json({ ok: true, broker: info.broker, equity: info.equity });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/breaker', async (_req, res) => {
  try { res.json(await guard.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/breaker/reset', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  await guard.reset('handmatig via dashboard');
  res.json({ ok: true });
});

app.post('/breaker/trip', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  await guard.trip(req.query.reason || 'handmatig gestopt via dashboard');
  res.json({ ok: true });
});

app.get('/slots', async (_req, res) => {
  try { res.json(await db.slotPerformance()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Telegram-watcher voedingsbron — VORM NIET WIJZIGEN ───────────────────
// Het aparte telegram-watcher-project polt dit elke 10 seconden en verwacht
// exact deze veldnamen. Verandert er iets aan de shape, dan valt de alerting
// stil zonder foutmelding.
app.get('/api/open-positions', async (_req, res) => {
  if (!broker.isReady()) return res.status(503).json({ error: 'broker niet verbonden' });
  try {
    const [live, orders] = await Promise.all([
      broker.positions(),
      db.openOrders(broker.accountId()),
    ]);
    const byPos = new Map(orders.map(o => [String(o.position_id), o]));
    const out = live.map(p => {
      const o = byPos.get(String(p.id));
      const symbol = p.symbol || o?.mt5_symbol || '';
      return {
        positionId: p.id,
        symbol,
        direction:  p.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
        entry:      p.openPrice,
        sl:         p.stopLoss   ?? (o ? Number(o.sl_price) : null),
        tp:         p.takeProfit ?? (o ? Number(o.tp_price) : null),
        lots:       p.volume,
        riskEur:    o ? Number(o.risk_amount) : null,
        assetType:  /NDX|US100|NAS/i.test(symbol) ? 'index' : 'fx',
        session:    o?.orb_start || null,
        dailyLabel: o?.slot_id || null,
      };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Voeding voor het dashboard ───────────────────────────────────────────
app.get('/api/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
    res.json(await db.tradesFeed(limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/signals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json(await db.signalsFeed(limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Eén call met alles wat de kop en het systeemtabblad nodig hebben. */
app.get('/api/system', async (_req, res) => {
  const out = {
    firm: FIRM, label: null, trading: TRADING_ENABLED,
    broker: broker.isReady(), broker_error: broker.lastError(),
    account: broker.accountId(), equity: null,
    open_positions: null, open_risk_pct: null,
    limits: { max_open: MAX_OPEN, max_risk_pct: MAX_RISK_TOTAL, max_basis_pct: MAX_BASIS_PCT },
    risk_per_trade: RISK_OVERRIDE !== null ? `${RISK_OVERRIDE}% (override)` : 'uit de webhook',
    default_risk_pct: DEFAULT_RISK_PCT,
    breaker: null, slots: [], basis: [], errors: [], symbols: {}, specs: SPECS,
    db_error: null, now: new Date().toISOString(),
  };
  try { out.label = firmConfig().label; out.symbols = firmConfig().symbols; } catch (e) { out.db_error = e.message; }
  if (broker.isReady()) { try { out.equity = await broker.equity(); } catch { /* niet fataal */ } }
  try {
    const { total, n } = await db.openRiskPct();
    out.open_positions = n; out.open_risk_pct = total;
    out.breaker = await guard.status();
    out.slots   = await db.slotPerformance();
    out.basis   = await db.basisDrift();
    out.errors  = await db.recentErrors(40);
  } catch (e) { out.db_error = e.message; }
  res.json(out);
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard
//
// Clientside gerenderd: de server stuurt alleen een skelet, de browser haalt
// JSON op en bouwt de tabellen. Twee redenen:
//   1. Geen HTML-injectie meer. De oude versie plakte reason-teksten (die
//      webhook-inhoud bevatten) rechtstreeks in de pagina.
//   2. Ververst zonder de hele pagina opnieuw op te bouwen.
//
// LET OP: dit hele blok leeft in een template-literal. Gebruik in het
// clientscript daarom GEEN backticks — alleen '+' en enkele aanhalingstekens.
// ═══════════════════════════════════════════════════════════════════════════
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;font-size:12px}
a{color:#58a6ff;text-decoration:none}
.hdr{background:#161b22;border-bottom:1px solid rgba(139,148,158,.15);padding:7px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;position:sticky;top:0;z-index:100}
.brand{font-size:13px;font-weight:700;letter-spacing:.3px}.brand span{color:#bc8cff}
.hkv{font-size:10px;color:#8b949e;white-space:nowrap}.hkv b{color:#e6edf3;font-variant-numeric:tabular-nums}
.hkv.g b{color:#3fb950}.hkv.r b{color:#f85149}.hkv.b b{color:#388bfd}.hkv.p b{color:#bc8cff}.hkv.y b{color:#d29922}
.hstat{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:10px;color:#8b949e}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
.dot.g{background:#3fb950;animation:blink 2s infinite}.dot.r{background:#f85149}.dot.b{background:#388bfd}.dot.y{background:#d29922}.dot.p{background:#bc8cff}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.nav{background:#161b22;border-bottom:1px solid rgba(139,148,158,.15);display:flex;padding:0 14px;overflow-x:auto}
.ntab{padding:9px 14px;font-size:11px;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;user-select:none}
.ntab:hover{color:#e6edf3}.ntab.on{color:#3fb950;border-bottom-color:#3fb950;font-weight:600}
.ntab:focus-visible{outline:2px solid #388bfd;outline-offset:-2px}
.wrapp{padding:12px 14px}
.pg{display:none}.pg.on{display:block}
.card{background:#161b22;border:1px solid rgba(139,148,158,.15);border-radius:6px;margin-bottom:10px;overflow:hidden}
.chdr{padding:7px 10px;border-bottom:1px solid rgba(139,148,158,.1);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ctitle{font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px}
.cm{margin-left:auto;font-size:9px;color:#6e7681}
.tw{width:100%;overflow-x:auto}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-size:9px;font-weight:500;color:#6e7681;padding:5px 6px;border-bottom:1px solid rgba(139,148,158,.15);white-space:nowrap;background:#161b22;position:sticky;top:0}
td{padding:4px 6px;border-bottom:1px solid rgba(139,148,158,.08);font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
tr:hover td{background:rgba(139,148,158,.05)}
.nd{text-align:center;color:#6e7681;padding:24px;font-size:11px}
.bd{display:inline-flex;align-items:center;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700}
.bd-buy{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
.bd-sell{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3)}
.bd-open{background:rgba(56,139,253,.15);color:#388bfd;border:1px solid rgba(56,139,253,.3)}
.bd-closed{background:rgba(139,148,158,.12);color:#8b949e;border:1px solid rgba(139,148,158,.25)}
.bd-failed{background:rgba(248,81,73,.25);color:#ff6b6b;border:1px solid #f85149}
.bd-acc{background:rgba(63,185,80,.12);color:#3fb950;border:1px solid rgba(63,185,80,.25)}
.bd-rej{background:rgba(210,153,34,.15);color:#d29922;border:1px solid rgba(210,153,34,.3)}
.bd-dup{background:rgba(139,148,158,.12);color:#8b949e;border:1px solid rgba(139,148,158,.25)}
.bd-err{background:rgba(248,81,73,.25);color:#ff6b6b;border:1px solid #f85149}
.bd-inv{background:rgba(210,153,34,.18);color:#d29922;border:1px solid rgba(210,153,34,.35)}
.kst{display:grid;gap:6px;padding:8px 10px}
.ks{background:#0d1117;border-radius:4px;padding:7px 10px;border:1px solid rgba(139,148,158,.1)}
.ksl{font-size:9px;color:#8b949e;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.ksv{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.cg{color:#3fb950}.cr{color:#f85149}.cb{color:#388bfd}.cp{color:#bc8cff}.cy{color:#d29922}.cd{color:#6e7681}.cc{color:#39d3f2}.cw{color:#e6edf3}
.segs{display:flex;background:#0d1117;border:1px solid rgba(139,148,158,.2);border-radius:4px;overflow:hidden}
.seg{padding:3px 10px;background:none;border:none;color:#6e7681;cursor:pointer;font-size:10px;font-family:inherit}
.seg.on{background:#21262d;color:#e6edf3}
input,select{background:#0d1117;color:#e6edf3;border:1px solid rgba(139,148,158,.25);border-radius:4px;font-size:10px;padding:3px 6px;font-family:inherit}
.btn{background:#21262d;color:#e6edf3;border:1px solid rgba(139,148,158,.25);border-radius:4px;padding:4px 10px;font-size:10px;cursor:pointer;font-family:inherit}
.btn:hover{background:#30363d}
.btn.danger{border-color:rgba(248,81,73,.4);color:#f85149}
.btn.ok{border-color:rgba(63,185,80,.4);color:#3fb950}

/* ── De conversieladder ────────────────────────────────────────────────
   Elk niveau uit de payload, omgerekend naar MT5 en geplaatst op zijn
   werkelijke afstand in % van de MT5-entry. Dit is de kern van de pagina:
   je ziet in één blik of SL, TP, ORB en VWAP kloppen ten opzichte van de
   prijs waarop je daadwerkelijk gevuld bent. */
.cv{background:#161b22;border:1px solid rgba(139,148,158,.15);border-radius:6px;margin-bottom:8px;overflow:hidden}
.cvh{padding:6px 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-bottom:1px solid rgba(139,148,158,.1)}
.cvid{font-size:10px;font-weight:600;color:#e6edf3}
.cvsub{font-size:9px;color:#6e7681}
.lad{position:relative;height:62px;margin:10px 12px 4px}
.lad-ax{position:absolute;left:0;right:0;top:31px;height:1px;background:rgba(139,148,158,.18)}
.lad-zero{position:absolute;top:8px;bottom:8px;width:1px;background:rgba(230,237,243,.5)}
.lad-m{position:absolute;top:22px;width:1px;height:19px}
.lad-l{position:absolute;font-size:8.5px;white-space:nowrap;transform:translateX(-50%);letter-spacing:.2px}
.lad-l.up{top:4px}.lad-l.dn{bottom:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:1px;background:rgba(139,148,158,.1)}
.gc{background:#0d1117;padding:5px 8px}
.gl{font-size:8.5px;color:#6e7681;text-transform:uppercase;letter-spacing:.4px}
.gv{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:1px}
.gx{font-size:8.5px;color:#8b949e;font-variant-numeric:tabular-nums}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:#0d1117}
::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const CLIENT = [
"'use strict';",
"var $=function(i){return document.getElementById(i)};",
"var S={trades:[],signals:[],sys:{},filt:'all',sfilt:'all'};",
"function esc(v){return String(v==null?'':v).replace(/[&<>\"']/g,function(c){",
"  return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]})}",
"function num(v){var n=parseFloat(v);return isFinite(n)?n:null}",
"function f(v,d){var n=num(v);return n===null?'--':n.toFixed(d==null?2:d)}",
"function pc(v,d){var n=num(v);if(n===null)return '--';",
"  return (n>0?'+':'')+n.toFixed(d==null?3:d)+'%'}",
"function ts(s){if(!s)return '--';",
"  return new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',",
"    day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}",
"function sgn(v){var n=num(v);return n===null?'cd':n>0?'cg':n<0?'cr':'cd'}",
"function bd(c,t){return '<span class=\"bd bd-'+c+'\">'+esc(t)+'</span>'}",
"",
"// Alles wat de payload stuurde, herrekend naar % van de MT5-entry.",
"// Waar we echte MT5-prijzen hebben gebruiken we die; anders vallen we terug",
"// op de opgeslagen sl_pct/tp_pct. Ontbreekt beide, dan blijft het null en",
"// tonen we een streepje in plaats van een verzonnen nul.",
"function conv(t){",
"  var fill=num(t.fill_price), c={fill:fill};",
"  var rel=function(lv){var p=num(lv);",
"    return (p===null||!fill)?null:(p/fill-1)*100};",
"  c.sl   = rel(t.sl_price);",
"  c.tp   = rel(t.tp_price);",
"  if(c.sl===null&&num(t.sl_pct)!==null) c.sl=(t.action==='buy'?-1:1)*num(t.sl_pct)*100;",
"  if(c.tp===null&&num(t.tp_pct)!==null) c.tp=(t.action==='buy'? 1:-1)*num(t.tp_pct)*100;",
"  c.orbH = rel(t.orb_high_mt5);",
"  c.orbL = rel(t.orb_low_mt5);",
"  c.vwap = rel(t.vwap_mt5);",
"  c.basis= num(t.basis_pct)===null?null:num(t.basis_pct)*100;",
"  c.range= (c.orbH!==null&&c.orbL!==null)?(c.orbH-c.orbL):null;",
"  var s=num(t.sl_pct), p=num(t.tp_pct);",
"  c.rrEff=(s&&p)?p/s:null;",
"  return c}",
"",
"function ladder(t,c){",
"  var pts=[{k:'ORB H',v:c.orbH,col:'#d29922'},{k:'TP',v:c.tp,col:'#3fb950'},",
"           {k:'VWAP',v:c.vwap,col:'#39d3f2'},{k:'ENTRY',v:0,col:'#e6edf3'},",
"           {k:'SL',v:c.sl,col:'#f85149'},{k:'ORB L',v:c.orbL,col:'#d29922'}];",
"  var live=pts.filter(function(p){return p.v!==null&&isFinite(p.v)});",
"  if(live.length<2) return '<div class=\"cd\" style=\"padding:10px 12px;font-size:10px\">"+
"Geen MT5-prijzen op deze order — niets om te schalen.</div>';",
"  var vs=live.map(function(p){return p.v});",
"  var lo=Math.min.apply(null,vs), hi=Math.max.apply(null,vs);",
"  var pad=Math.max((hi-lo)*0.14,0.02); lo-=pad; hi+=pad;",
"  var x=function(v){return ((v-lo)/(hi-lo))*100};",
"  var h='<div class=\"lad\"><div class=\"lad-ax\"></div>';",
"  h+='<div class=\"lad-zero\" style=\"left:'+x(0).toFixed(2)+'%\"></div>';",
"  live.sort(function(a,b){return a.v-b.v});",
"  live.forEach(function(p,i){",
"    var L=x(p.v).toFixed(2), up=(i%2===0);",
"    h+='<div class=\"lad-m\" style=\"left:'+L+'%;background:'+p.col+'\"></div>';",
"    h+='<div class=\"lad-l '+(up?'up':'dn')+'\" style=\"left:'+L+'%;color:'+p.col+'\">'",
"       +esc(p.k)+' '+(p.v>0?'+':'')+p.v.toFixed(3)+'%</div>'});",
"  return h+'</div>'}",
"",
"function cell(l,v,x,cl){return '<div class=\"gc\"><div class=\"gl\">'+esc(l)+'</div>'+",
"  '<div class=\"gv '+(cl||'cw')+'\">'+v+'</div>'+",
"  (x?'<div class=\"gx\">'+x+'</div>':'')+'</div>'}",
"",
"function renderConv(){",
"  var rows=S.trades.slice(0,40);",
"  if(!rows.length){$('cv-body').innerHTML='<div class=\"nd\">Nog geen orders. "+
"Zodra TradingView een signaal stuurt verschijnt hier de omrekening.</div>';return}",
"  $('cv-body').innerHTML=rows.map(function(t){",
"    var c=conv(t), dir=t.action==='buy';",
"    var h='<div class=\"cv\"><div class=\"cvh\">'+bd(dir?'buy':'sell',dir?'BUY':'SELL')+",
"      '<span class=\"cvid\">'+esc(t.slot_id)+'</span>'+",
"      '<span class=\"cvsub\">'+esc(t.tv_symbol||'?')+' &rarr; '+esc(t.mt5_symbol||'?')+",
"      ' · '+ts(t.placed_at)+'</span>';",
"    if(t.valid===false) h+=bd('inv','DATA '+esc(t.invalid_reason||'ongeldig'));",
"    h+='<span class=\"cm\">basis '+pc(c.basis,3)+'</span></div>';",
"    h+=ladder(t,c);",
"    h+='<div class=\"grid\">';",
"    h+=cell('Entry MT5',f(t.fill_price,5),'TV '+f(t.entry_tv,5),'cw');",
"    h+=cell('Stop loss',f(t.sl_price,5),pc(c.sl,3)+' · '+f(t.sl_points,5)+' pt','cr');",
"    h+=cell('Take profit',f(t.tp_price,5),pc(c.tp,3)+' · '+f(t.tp_points,5)+' pt','cg');",
"    h+=cell('ORB hoog',f(t.orb_high_mt5,5),pc(c.orbH,3)+' · TV '+f(t.orb_high,5),'cy');",
"    h+=cell('ORB laag',f(t.orb_low_mt5,5),pc(c.orbL,3)+' · TV '+f(t.orb_low,5),'cy');",
"    h+=cell('VWAP',f(t.vwap_mt5,5),pc(c.vwap,3)+' · '+esc(t.vwap_side||'?'),'cc');",
"    h+=cell('ORB-breedte',c.range===null?'--':c.range.toFixed(3)+'%',",
"      esc(t.orb_start||'?')+' · '+esc(t.orb_minutes||'?')+'m','cw');",
"    h+=cell('Stop TV&rarr;MT5',f(t.sl_points_tv,5)+' &rarr; '+f(t.sl_points,5),",
"      'schaal '+pc(c.basis,3),'cd');",
"    h+=cell('RR',f(t.rr,2)+'R','effectief '+(c.rrEff?c.rrEff.toFixed(2):'--')+'R','cw');",
"    h+=cell('SL-mult',f(t.sl_mult,1)+'&times;','risk '+f(t.risk_pct,2)+'%','cd');",
"    h+=cell('Volume',f(t.volume,2)+' lot','risico '+f(t.risk_amount,2),'cw');",
"    h+=cell('Uitkomst',t.r_multiple==null?'open':f(t.r_multiple,2)+'R',",
"      t.profit==null?esc(t.status):f(t.profit,2)+' · '+esc(t.close_reason||''),",
"      t.r_multiple==null?'cb':sgn(t.r_multiple));",
"    return h+'</div></div>'}).join('')}",
"",
"function renderTrades(){",
"  var rows=S.trades.filter(function(t){",
"    if(S.filt==='open')   return t.status==='open';",
"    if(S.filt==='closed') return t.status==='closed';",
"    if(S.filt==='failed') return t.status==='failed';",
"    if(S.filt==='invalid')return t.valid===false;",
"    return true});",
"  $('tr-count').textContent=rows.length+' van '+S.trades.length;",
"  if(!rows.length){$('tr-body').innerHTML='<tr><td colspan=\"15\" class=\"nd\">"+
"Niets in deze weergave.</td></tr>';return}",
"  $('tr-body').innerHTML=rows.map(function(t){",
"    var c=conv(t);",
"    var st=t.status==='open'?bd('open','OPEN'):t.status==='closed'?bd('closed','DICHT'):bd('failed','MISLUKT');",
"    return '<tr><td class=\"cd\">'+ts(t.placed_at)+'</td>'+",
"      '<td>'+esc(t.slot_id)+'</td>'+",
"      '<td class=\"cd\">'+esc(t.mt5_symbol||'--')+'</td>'+",
"      '<td>'+bd(t.action==='buy'?'buy':'sell',t.action==='buy'?'BUY':'SELL')+'</td>'+",
"      '<td>'+st+(t.valid===false?' '+bd('inv','DATA'):'')+'</td>'+",
"      '<td>'+f(t.fill_price,5)+'</td>'+",
"      '<td class=\"cr\">'+pc(c.sl,3)+'</td>'+",
"      '<td class=\"cg\">'+pc(c.tp,3)+'</td>'+",
"      '<td class=\"cy\">'+pc(c.orbH,3)+'</td>'+",
"      '<td class=\"cy\">'+pc(c.orbL,3)+'</td>'+",
"      '<td class=\"cc\">'+pc(c.vwap,3)+'</td>'+",
"      '<td class=\"cd\">'+pc(c.basis,3)+'</td>'+",
"      '<td>'+f(t.volume,2)+'</td>'+",
"      '<td class=\"'+sgn(t.profit)+'\">'+(t.profit==null?'--':f(t.profit,2))+'</td>'+",
"      '<td class=\"'+sgn(t.r_multiple)+'\">'+(t.r_multiple==null?'--':f(t.r_multiple,2)+'R')+'</td></tr>'",
"  }).join('')}",
"",
"function renderSignals(){",
"  var rows=S.signals.filter(function(s){",
"    if(S.sfilt==='blocked') return s.status!=='accepted';",
"    if(S.sfilt==='accepted')return s.status==='accepted';",
"    return true});",
"  if(!rows.length){$('sg-body').innerHTML='<tr><td colspan=\"10\" class=\"nd\">"+
"Geen signalen in deze weergave.</td></tr>';return}",
"  $('sg-body').innerHTML=rows.map(function(s){",
"    var cl=s.status==='accepted'?'acc':s.status==='rejected'?'rej':",
"           s.status==='duplicate'?'dup':'err';",
"    return '<tr><td class=\"cd\">'+ts(s.received_at)+'</td>'+",
"      '<td>'+esc(s.slot_id)+'</td>'+",
"      '<td class=\"cd\">'+esc(s.tv_symbol||'--')+'</td>'+",
"      '<td>'+bd(s.action==='buy'?'buy':'sell',(s.action||'?').toUpperCase())+'</td>'+",
"      '<td>'+bd(cl,(s.status||'?').toUpperCase())+'</td>'+",
"      '<td>'+f(s.entry_tv,5)+'</td>'+",
"      '<td class=\"cr\">'+(num(s.sl_pct)===null?'--':pc(num(s.sl_pct)*100,3))+'</td>'+",
"      '<td class=\"cg\">'+(num(s.tp_pct)===null?'--':pc(num(s.tp_pct)*100,3))+'</td>'+",
"      '<td class=\"cd\">'+esc(s.orb_start||'--')+' '+esc(s.orb_minutes||'')+'m</td>'+",
"      '<td class=\"cd\" style=\"white-space:normal;max-width:340px\">'+esc(s.reason||'')+'</td></tr>'",
"  }).join('')}",
"",
"function renderSlots(){",
"  var r=S.sys.slots||[];",
"  if(!r.length){$('sl-body').innerHTML='<tr><td colspan=\"9\" class=\"nd\">"+
"Nog geen gesloten trades per slot.</td></tr>';return}",
"  $('sl-body').innerHTML=r.map(function(s){",
"    return '<tr><td>'+esc(s.slot_id)+'</td>'+",
"      '<td class=\"cd\">'+esc(s.mt5_symbol||'--')+'</td>'+",
"      '<td>'+esc(s.n_orders)+'</td><td>'+esc(s.n_closed)+'</td>'+",
"      '<td class=\"'+sgn(s.avg_r)+'\">'+f(s.avg_r,3)+'</td>'+",
"      '<td class=\"'+sgn(s.total_profit)+'\">'+f(s.total_profit,2)+'</td>'+",
"      '<td>'+(s.win_pct==null?'--':f(s.win_pct,1)+'%')+'</td>'+",
"      '<td class=\"cd\">'+(s.avg_minutes==null?'--':s.avg_minutes+'m')+'</td>'+",
"      '<td class=\"cd\">'+f(s.avg_slippage,5)+'</td></tr>'}).join('')}",
"",
"function renderSys(){",
"  var s=S.sys, b=s.breaker||{};",
"  $('sy-brk').innerHTML = b.tripped",
"    ? '<span class=\"dot r\"></span> GETRIPT &mdash; '+esc(b.reason||'geen reden')",
"    : '<span class=\"dot g\"></span> normaal';",
"  $('sy-brk-since').textContent = b.since?('sinds '+ts(b.since)):'';",
"  var k=[['Firm',esc(s.label||s.firm),'cw'],",
"         ['Handel',s.trading?'AAN':'UIT',s.trading?'cg':'cy'],",
"         ['Broker',s.broker?'verbonden':'weg',s.broker?'cg':'cr'],",
"         ['Equity',f(s.equity,2),'cw'],",
"         ['Open risico',f(s.open_risk_pct,2)+'%','cb'],",
"         ['Risico/trade',esc(s.risk_per_trade),'cp']];",
"  $('sy-kpi').innerHTML=k.map(function(x){",
"    return '<div class=\"ks\"><div class=\"ksl\">'+x[0]+'</div>'+",
"      '<div class=\"ksv '+x[2]+'\">'+x[1]+'</div></div>'}).join('');",
"  $('sy-err-box').innerHTML = s.broker_error",
"    ? '<div style=\"padding:8px 10px;font-size:10px\" class=\"cr\">'+esc(s.broker_error)+'</div>' : '';",
"  var bs=s.basis||[];",
"  $('sy-basis').innerHTML = bs.length ? bs.map(function(x){",
"    return '<tr><td>'+esc(x.mt5_symbol)+'</td><td>'+esc(x.n)+'</td>'+",
"      '<td>'+f(x.gem_basis_pct,4)+'%</td><td class=\"cd\">'+f(x.min_basis_pct,4)+'%</td>'+",
"      '<td class=\"cd\">'+f(x.max_basis_pct,4)+'%</td>'+",
"      '<td class=\"'+(num(x.sd_basis_pct)>0.3?'cy':'cd')+'\">'+f(x.sd_basis_pct,4)+'%</td></tr>'",
"    }).join('') : '<tr><td colspan=\"6\" class=\"nd\">Nog geen omgerekende orders.</td></tr>';",
"  var er=s.errors||[];",
"  $('sy-errors').innerHTML = er.length ? er.map(function(e){",
"    return '<tr><td class=\"cd\">'+ts(e.at)+'</td><td>'+esc(e.context)+'</td>'+",
"      '<td class=\"cd\" style=\"white-space:normal\">'+esc(e.message)+'</td></tr>'",
"    }).join('') : '<tr><td colspan=\"3\" class=\"nd\">Geen fouten gelogd.</td></tr>';",
"  var sy=s.symbols||{}, rows=Object.keys(sy).map(function(k2){",
"    var m=sy[k2], sp=(s.specs||{})[m];",
"    return '<tr><td>'+esc(k2)+'</td><td>'+esc(m)+'</td>'+",
"      '<td class=\"cd\">'+(sp?('tick '+sp.tickSize+' · waarde '+sp.tickValue+' · '+",
"      'vol '+sp.volMin+'-'+sp.volMax):'geen specificatie')+'</td></tr>'});",
"  $('sy-syms').innerHTML=rows.join('')}",
"",
"function renderHdr(){",
"  var s=S.sys, b=s.breaker||{};",
"  $('h-firm').textContent=s.label||s.firm||'--';",
"  $('h-eq').textContent=f(s.equity,2);",
"  $('h-open').textContent=(s.open_positions==null?'--':s.open_positions)+'/'+",
"    ((s.limits&&s.limits.max_open)||'--');",
"  $('h-risk').textContent=f(s.open_risk_pct,2)+'%';",
"  $('h-acct').textContent=s.account?String(s.account).slice(0,8)+'…':'--';",
"  var d=$('h-dot'), st=$('h-state');",
"  if(b.tripped){d.className='dot r';st.textContent='breaker om'}",
"  else if(!s.broker){d.className='dot y';st.textContent='broker weg'}",
"  else if(!s.trading){d.className='dot b';st.textContent='dry run'}",
"  else{d.className='dot g';st.textContent='live'}",
"  $('h-time').textContent=new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels'});",
"  $('nb-inv').textContent=S.trades.filter(function(t){return t.valid===false}).length;",
"  $('nb-sg').textContent=S.signals.filter(function(x){return x.status!=='accepted'}).length}",
"",
"function go(id,el){",
"  var ps=document.querySelectorAll('.pg');",
"  for(var i=0;i<ps.length;i++) ps[i].classList.remove('on');",
"  $('p-'+id).classList.add('on');",
"  var ts2=document.querySelectorAll('.ntab');",
"  for(var j=0;j<ts2.length;j++) ts2[j].classList.remove('on');",
"  el.classList.add('on')}",
"",
"function setFilt(v,el){S.filt=v;",
"  var b=el.parentNode.children;for(var i=0;i<b.length;i++)b[i].classList.remove('on');",
"  el.classList.add('on');renderTrades()}",
"function setSFilt(v,el){S.sfilt=v;",
"  var b=el.parentNode.children;for(var i=0;i<b.length;i++)b[i].classList.remove('on');",
"  el.classList.add('on');renderSignals()}",
"",
"function secret(){return encodeURIComponent($('sy-secret').value||'')}",
"function post(p){",
"  fetch(p+(p.indexOf('?')<0?'?':'&')+'secret='+secret(),{method:'POST'})",
"    .then(function(r){return r.json()})",
"    .then(function(j){ $('sy-msg').textContent = j.error?('mislukt: '+j.error):'gelukt'; load()})",
"    .catch(function(e){ $('sy-msg').textContent='mislukt: '+e.message })}",
"",
"function load(){",
"  Promise.all([",
"    fetch('/api/system').then(function(r){return r.json()}).catch(function(){return {}}),",
"    fetch('/api/trades?limit=400').then(function(r){return r.json()}).catch(function(){return []}),",
"    fetch('/api/signals?limit=250').then(function(r){return r.json()}).catch(function(){return []})",
"  ]).then(function(a){",
"    S.sys=a[0]||{}; S.trades=Array.isArray(a[1])?a[1]:[]; S.signals=Array.isArray(a[2])?a[2]:[];",
"    renderHdr(); renderTrades(); renderConv(); renderSignals(); renderSlots(); renderSys()})}",
"",
"load(); setInterval(load,15000);",
].join("\n");

function dashboardHTML() {
  return '<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>PRONTO ORB · ' + FIRM.toUpperCase() + '</title><style>' + CSS + '</style></head><body>' +

  '<div class="hdr">' +
    '<div class="brand">PRONTO<span>·</span>ORB <span style="font-size:10px;color:#6e7681;font-weight:400" id="h-firm">--</span></div>' +
    '<div class="hkv g">Equity <b id="h-eq">--</b></div>' +
    '<div class="hkv b">Open <b id="h-open">--</b></div>' +
    '<div class="hkv y">Risico <b id="h-risk">--</b></div>' +
    '<div class="hkv p">Account <b id="h-acct">--</b></div>' +
    '<div class="hstat"><span id="h-dot" class="dot b"></span><span id="h-state">verbinden…</span>' +
    '<span id="h-time" class="cd" style="margin-left:4px">--</span></div>' +
  '</div>' +

  '<div class="nav">' +
    '<div class="ntab on" tabindex="0" onclick="go(\'tr\',this)">Trades</div>' +
    '<div class="ntab" tabindex="0" onclick="go(\'cv\',this)">Omrekening ' +
      '<span style="background:rgba(210,153,34,.15);color:#d29922;border-radius:8px;padding:1px 5px;font-size:9px" id="nb-inv">0</span></div>' +
    '<div class="ntab" tabindex="0" onclick="go(\'sl\',this)">Slots</div>' +
    '<div class="ntab" tabindex="0" onclick="go(\'sg\',this)">Signalen ' +
      '<span style="background:rgba(139,148,158,.15);color:#8b949e;border-radius:8px;padding:1px 5px;font-size:9px" id="nb-sg">0</span></div>' +
    '<div class="ntab" tabindex="0" onclick="go(\'sy\',this)">Systeem</div>' +
  '</div>' +

  '<div class="wrapp">' +

  '<div class="pg on" id="p-tr"><div class="card">' +
    '<div class="chdr"><div class="ctitle"><div class="dot g"></div>Orders</div>' +
    '<div class="segs" style="margin-left:8px">' +
      '<button class="seg on" onclick="setFilt(\'all\',this)">Alles</button>' +
      '<button class="seg" onclick="setFilt(\'open\',this)">Open</button>' +
      '<button class="seg" onclick="setFilt(\'closed\',this)">Dicht</button>' +
      '<button class="seg" onclick="setFilt(\'failed\',this)">Mislukt</button>' +
      '<button class="seg" onclick="setFilt(\'invalid\',this)">Datafout</button></div>' +
    '<span class="cm" id="tr-count">--</span></div>' +
    '<div class="tw"><table><thead><tr>' +
      '<th>Tijd</th><th>Slot</th><th>Symbool</th><th>Richting</th><th>Status</th>' +
      '<th>Entry MT5</th><th>SL %</th><th>TP %</th><th>ORB H %</th><th>ORB L %</th>' +
      '<th>VWAP %</th><th>Basis %</th><th>Lots</th><th>P&amp;L</th><th>R</th>' +
    '</tr></thead><tbody id="tr-body"><tr><td colspan="15" class="nd">Laden…</td></tr></tbody></table></div>' +
    '<div class="cm" style="padding:6px 10px">Alle percentages zijn afstand tot de werkelijke MT5-fill, niet tot de TradingView-prijs.</div>' +
  '</div></div>' +

  '<div class="pg" id="p-cv">' +
    '<div class="card"><div class="chdr"><div class="ctitle"><div class="dot y"></div>Futures naar CFD</div>' +
    '<span class="cm">elk niveau uit de payload, geplaatst op zijn afstand in % van de MT5-entry</span></div>' +
    '<div class="cm" style="padding:8px 10px;line-height:1.5">De witte lijn is je fill. ' +
    'Staat VWAP aan de verkeerde kant van entry, of ligt de stop niet waar de ORB-rand ligt, ' +
    'dan klopt de omrekening niet — ongeacht wat de order zelf deed.</div></div>' +
    '<div id="cv-body"><div class="nd">Laden…</div></div>' +
  '</div>' +

  '<div class="pg" id="p-sl"><div class="card">' +
    '<div class="chdr"><div class="ctitle"><div class="dot b"></div>Prestatie per slot</div>' +
    '<span class="cm">uit de slot_performance-view</span></div>' +
    '<div class="tw"><table><thead><tr><th>Slot</th><th>Symbool</th><th>Orders</th><th>Dicht</th>' +
    '<th>Gem. R</th><th>Winst</th><th>Win%</th><th>Duur</th><th>Slippage</th></tr></thead>' +
    '<tbody id="sl-body"><tr><td colspan="9" class="nd">Laden…</td></tr></tbody></table></div>' +
    '<div class="cm" style="padding:6px 10px">Slippage is nul zolang broker.js de ref-prijs als fill teruggeeft — dat is een bekende bug, geen meting.</div>' +
  '</div></div>' +

  '<div class="pg" id="p-sg"><div class="card">' +
    '<div class="chdr"><div class="ctitle"><div class="dot p"></div>Signaal-log</div>' +
    '<div class="segs" style="margin-left:8px">' +
      '<button class="seg on" onclick="setSFilt(\'all\',this)">Alles</button>' +
      '<button class="seg" onclick="setSFilt(\'accepted\',this)">Geaccepteerd</button>' +
      '<button class="seg" onclick="setSFilt(\'blocked\',this)">Geblokkeerd</button></div>' +
    '<span class="cm">élk binnengekomen signaal, ook geweigerde</span></div>' +
    '<div class="tw"><table><thead><tr><th>Tijd</th><th>Slot</th><th>TV-symbool</th><th>Richting</th>' +
    '<th>Status</th><th>Entry TV</th><th>SL %</th><th>TP %</th><th>ORB</th><th>Reden</th></tr></thead>' +
    '<tbody id="sg-body"><tr><td colspan="10" class="nd">Laden…</td></tr></tbody></table></div>' +
  '</div></div>' +

  '<div class="pg" id="p-sy">' +
    '<div class="card"><div class="chdr"><div class="ctitle"><div class="dot g"></div>Toestand</div></div>' +
    '<div class="kst" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))" id="sy-kpi"></div>' +
    '<div id="sy-err-box"></div></div>' +

    '<div class="card"><div class="chdr"><div class="ctitle"><div class="dot y"></div>Circuit breaker</div>' +
    '<span class="cm" id="sy-brk-since"></span></div>' +
    '<div style="padding:8px 10px;font-size:11px" id="sy-brk">--</div>' +
    '<div style="padding:0 10px 10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      '<input id="sy-secret" type="password" placeholder="webhook secret" style="width:180px">' +
      '<button class="btn danger" onclick="post(\'/breaker/trip\')">Stop handel</button>' +
      '<button class="btn ok" onclick="post(\'/breaker/reset\')">Hervat handel</button>' +
      '<button class="btn" onclick="post(\'/reconnect\')">Verbind opnieuw</button>' +
      '<span class="cm" id="sy-msg"></span></div>' +
    '<div class="cm" style="padding:0 10px 8px">Het secret blijft in dit tabblad en wordt niet opgeslagen.</div></div>' +

    '<div class="card"><div class="chdr"><div class="ctitle"><div class="dot b"></div>Basisdrift</div>' +
    '<span class="cm">spreiding futures &rarr; CFD · brede spreiding wijst op vertraagde data</span></div>' +
    '<div class="tw"><table><thead><tr><th>Symbool</th><th>n</th><th>Gemiddeld</th>' +
    '<th>Min</th><th>Max</th><th>Std.dev</th></tr></thead><tbody id="sy-basis"></tbody></table></div></div>' +

    '<div class="card"><div class="chdr"><div class="ctitle"><div class="dot p"></div>Symboolmapping</div>' +
    '<span class="cm">uit session.js</span></div>' +
    '<div class="tw"><table><thead><tr><th>TradingView</th><th>MT5</th><th>Specificatie</th></tr></thead>' +
    '<tbody id="sy-syms"></tbody></table></div></div>' +

    '<div class="card"><div class="chdr"><div class="ctitle"><div class="dot r"></div>Laatste fouten</div></div>' +
    '<div class="tw"><table><thead><tr><th>Tijd</th><th>Context</th><th>Bericht</th></tr></thead>' +
    '<tbody id="sy-errors"></tbody></table></div></div>' +

    '<div class="cm" style="padding:4px 2px">JSON: ' +
    '<a href="/health">/health</a> · <a href="/api/trades">/api/trades</a> · ' +
    '<a href="/api/signals">/api/signals</a> · <a href="/api/system">/api/system</a> · ' +
    '<a href="/api/open-positions">/api/open-positions</a></div>' +
  '</div>' +

  '</div><script>' + CLIENT + '</scr' + 'ipt></body></html>';
}

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHTML());
});
app.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHTML());
});

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
      const stranded = await db.strandedOrders(broker.accountId());
      if (stranded.length) {
        console.warn('[MT5] LET OP — open orders van (een) ander account in de database:');
        stranded.forEach(r => console.warn(`   account ${r.account_id}: ${r.n} open order(s) — worden genegeerd`));
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
