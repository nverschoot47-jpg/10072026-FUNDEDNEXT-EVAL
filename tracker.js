// ═══════════════════════════════════════════════════════════════════════════
// tracker.js — kijkt periodiek welke posities dicht zijn en schrijft de uitkomst weg.
//
// De houdtijd is bewust onbegrensd: een positie blijft open tot SL, TP, of tot
// jij hem sluit. Staat ENFORCE_EXPIRY op true, dan sluit deze poller hem alsnog
// op het expires_at-moment uit de PineScript-payload.
// ═══════════════════════════════════════════════════════════════════════════
import * as db from './db.js';
import * as broker from './broker.js';
import { valuePerUnit, ENFORCE_EXPIRY, TRACK_INTERVAL } from './session.js';

function reason(order, closePrice) {
  if (closePrice == null) return 'unknown';
  const long = order.action === 'buy';
  const tp = parseFloat(order.tp_price), sl = parseFloat(order.sl_price);
  const near = (a, b) => Math.abs(a - b) <= Math.abs(parseFloat(order.sl_points)) * 0.05;
  if (near(closePrice, tp)) return 'tp';
  if (near(closePrice, sl)) return 'sl';
  return long ? (closePrice > parseFloat(order.fill_price) ? 'manual_win' : 'manual_loss')
              : (closePrice < parseFloat(order.fill_price) ? 'manual_win' : 'manual_loss');
}

async function sweep() {
  if (!broker.isReady()) return;

  const open = await db.openOrders(broker.accountId());
  if (!open.length) return;

  const live   = await broker.positions();
  const liveId = new Set(live.map(p => String(p.id)));

  for (const o of open) {
    // ── nog open: eventueel verlopen? ────────────────────────────────────
    if (liveId.has(String(o.position_id))) {
      if (ENFORCE_EXPIRY) {
        const r = await db.pool.query(
          `SELECT s.expires_at FROM signals s JOIN orders x ON x.signal_id = s.id WHERE x.id = $1`, [o.id]);
        const exp = r.rows[0]?.expires_at;
        if (exp && new Date(exp) <= new Date()) {
          try {
            await broker.closePosition(o.position_id);
            console.log(`[Tracker] ${o.slot_id} gesloten op expires_at`);
          } catch (e) { await db.logError('expiry', e.message, { order: o.id }); }
        }
      }
      continue;
    }

    // ── weg uit de open posities: uitkomst ophalen ───────────────────────
    try {
      const deals = await broker.historyForPosition(o.position_id, new Date(o.placed_at).getTime());
      const exits = deals.filter(d => d.entryType === 'DEAL_ENTRY_OUT' || d.type?.includes('DEAL_TYPE_'));
      const profit     = deals.reduce((s, d) => s + (d.profit     || 0), 0);
      const swap       = deals.reduce((s, d) => s + (d.swap       || 0), 0);
      const commission = deals.reduce((s, d) => s + (d.commission || 0), 0);
      const closePrice = exits.length ? exits[exits.length - 1].price : null;

      const risk = parseFloat(o.risk_amount) || null;
      const rMul = risk ? +(profit / risk).toFixed(3) : null;
      const mins = Math.round((Date.now() - new Date(o.placed_at).getTime()) / 60000);

      await db.closeOrder(o.id, {
        slot_id: o.slot_id,
        close_price: closePrice,
        profit: +profit.toFixed(2),
        swap: +swap.toFixed(2),
        commission: +commission.toFixed(2),
        duration_min: mins,
        r_multiple: rMul,
        close_reason: reason(o, closePrice),
      });
      console.log(`[Tracker] ${o.slot_id} dicht — ${profit.toFixed(2)} (${rMul ?? '?'}R) na ${mins} min`);
    } catch (e) {
      await db.logError('tracker', e.message, { order: o.id, position: o.position_id });
    }
  }
}

export function start() {
  setInterval(() => sweep().catch(e => db.logError('tracker.sweep', e.message)), TRACK_INTERVAL);
  console.log(`[Tracker] actief, elke ${TRACK_INTERVAL / 1000}s`);
}
