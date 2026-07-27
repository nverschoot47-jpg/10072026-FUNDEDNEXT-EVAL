// ═══════════════════════════════════════════════════════════════════════════
// db.js — Postgres-laag. Alles wat naar de database gaat, gaat hierlangs.
//
// Aangepast voor het nieuwe dashboard: tradesFeed() en signalsFeed() geven nu
// ALLE omgerekende MT5-velden terug die server.js al wegschreef maar die
// nergens werden uitgelezen. Het handelspad is ongewijzigd.
// ═══════════════════════════════════════════════════════════════════════════
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const done = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename));

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const f of files) {
    if (done.has(f)) { console.log(`[DB] ${f} al toegepast, overgeslagen`); continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`[DB] ${f} toegepast`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`[DB] ${f} MISLUKT: ${e.message}`);
      throw e;
    } finally {
      client.release();
    }
  }
}

export async function logError(context, message, payload = null) {
  try {
    await pool.query(
      'INSERT INTO errors (context, message, payload) VALUES ($1, $2, $3)',
      [context, String(message).slice(0, 4000), payload ? JSON.stringify(payload) : null]
    );
  } catch (e) {
    console.error('[DB] kon fout niet loggen:', e.message);
  }
  console.error(`[${context}] ${message}`);
}

function bouwInsert(tabel, obj, extra = '') {
  const cols = Object.keys(obj);
  const ph   = cols.map((_, i) => `$${i + 1}`).join(',');
  return {
    sql: `INSERT INTO ${tabel} (${cols.join(',')}) VALUES (${ph}) ${extra}`,
    vals: cols.map(c => obj[c] ?? null),
  };
}

export async function insertSignal(firm, o, mt5Symbol, status, reason) {
  const rij = {
    firm,
    slot_id:     o.slot_id,
    slot:        o.slot ?? null,
    trade_no:    o.trade_no ?? null,
    action:      o.action,
    tv_symbol:   o.symbol,
    mt5_symbol:  mt5Symbol,
    entry_tv:    o.entry ?? null,
    sl_points:   o.sl_points ?? null,
    tp_points:   o.tp_points ?? null,
    rr:          o.rr ?? null,
    sl_mult:     o.sl_mult ?? null,
    orb_start:   o.orb_start ?? null,
    orb_minutes: o.orb_minutes ?? null,
    orb_high:    o.orb_high ?? null,
    orb_low:     o.orb_low ?? null,
    vwap_side:   o.vwap_side ?? null,
    vwap:        o.vwap ?? null,
    risk_pct:    o.risk_pct ?? null,
    expires_at:  o.expires_at ?? null,
    account_id:  o.__account ?? null,
    status,
    reason:      reason ?? null,
    raw:         JSON.stringify(o),
  };

  const q = bouwInsert('signals', rij, 'RETURNING id');
  try {
    const r = await pool.query(q.sql, q.vals);
    return { id: r.rows[0].id, duplicate: false };
  } catch (e) {
    if (e.code === '23505') {
      const dup = bouwInsert('signals',
        { ...rij, status: 'duplicate', reason: 'slot vuurde vandaag al' });
      await pool.query(dup.sql, dup.vals);
      return { id: null, duplicate: true };
    }
    if (e.code === '42703') {
      throw new Error(`kolom ontbreekt in signals — draait migratie 003/004 al? (${e.message})`);
    }
    throw e;
  }
}

export async function insertOrder(row) {
  const q = bouwInsert('orders', row, 'RETURNING id');
  const r = await pool.query(q.sql, q.vals);
  return r.rows[0].id;
}

export async function openOrders(accountId) {
  const r = await pool.query(
    `SELECT o.id, o.slot_id, o.mt5_symbol, o.action, o.volume, o.fill_price, o.sl_price, o.tp_price,
            o.sl_points, o.risk_amount, o.position_id, o.placed_at, s.orb_start
       FROM orders o
       LEFT JOIN signals s ON s.id = o.signal_id
      WHERE o.status = 'open' AND o.position_id IS NOT NULL
        AND o.account_id IS NOT DISTINCT FROM $1`, [accountId]);
  return r.rows;
}

/**
 * Volledige trade-feed voor het dashboard.
 *
 * Geeft per order DRIE werelden naast elkaar terug:
 *   1. wat TradingView stuurde  (entry_tv, sl_points_tv, orb_high, vwap, ...)
 *   2. wat er op MT5 gebeurde   (fill_price, sl_price, orb_high_mt5, ...)
 *   3. de verhouding ertussen   (sl_pct, tp_pct, basis_pct)
 *
 * Het dashboard rekent daaruit alles om naar % van de MT5-entry. Dat kan
 * clientside omdat alle ingrediënten in de rij zitten — geen extra query's.
 */
export async function tradesFeed(limit = 300) {
  const r = await pool.query(
    `SELECT o.id, o.placed_at, o.account_id, o.slot_id, o.mt5_symbol, o.action,
            o.status, o.valid, o.invalid_reason, o.error, o.position_id,
            o.volume, o.risk_amount, o.equity_at_open, o.slippage,

            -- TradingView-wereld (futures)
            o.entry_tv, o.sl_points_tv, o.tp_points_tv,

            -- MT5-wereld (CFD)
            o.fill_price, o.sl_price, o.tp_price, o.sl_points, o.tp_points,
            o.orb_high_mt5, o.orb_low_mt5, o.vwap_mt5,

            -- verhouding tussen beide
            o.basis, o.basis_pct, o.sl_pct, o.tp_pct,

            -- signaalcontext, ruw zoals PineScript hem stuurde
            s.received_at, s.tv_symbol, s.slot AS slot_nr, s.trade_no,
            s.rr, s.sl_mult, s.orb_start, s.orb_minutes,
            s.orb_high, s.orb_low, s.vwap, s.vwap_side,
            s.risk_pct, s.expires_at, s.status AS signal_status, s.reason AS signal_reason,

            -- uitkomst
            c.closed_at, c.close_price, c.profit, c.swap, c.commission,
            c.duration_min, c.r_multiple, c.close_reason
       FROM orders o
       LEFT JOIN signals s ON s.id = o.signal_id
       LEFT JOIN closes  c ON c.order_id = o.id
      ORDER BY o.placed_at DESC
      LIMIT $1`, [limit]);
  return r.rows;
}

/**
 * Signaal-log: élk binnengekomen signaal, ook geweigerde en duplicaten.
 * Dit is de enige plek waar je ziet WAAROM er niets geplaatst is.
 */
export async function signalsFeed(limit = 200) {
  const r = await pool.query(
    `SELECT s.id, s.received_at, s.trade_date, s.slot_id, s.slot AS slot_nr, s.trade_no,
            s.action, s.tv_symbol, s.mt5_symbol, s.status, s.reason,
            s.entry_tv, s.sl_points, s.tp_points, s.sl_pct, s.tp_pct,
            s.rr, s.sl_mult, s.orb_start, s.orb_minutes, s.orb_high, s.orb_low,
            s.vwap, s.vwap_side, s.risk_pct, s.expires_at, s.account_id,
            o.id AS order_id, o.fill_price
       FROM signals s
       LEFT JOIN orders o ON o.signal_id = s.id
      ORDER BY s.id DESC
      LIMIT $1`, [limit]);
  return r.rows;
}

/** Laatste fouten uit de errors-tabel, voor het systeemtabblad. */
export async function recentErrors(limit = 40) {
  const r = await pool.query(
    'SELECT id, at, context, message FROM errors ORDER BY id DESC LIMIT $1', [limit]);
  return r.rows;
}

/** Open orders die bij een ANDER account horen — puur om voor te waarschuwen. */
export async function strandedOrders(accountId) {
  const r = await pool.query(
    `SELECT account_id, COUNT(*)::int AS n
       FROM orders
      WHERE status = 'open' AND account_id IS DISTINCT FROM $1
      GROUP BY account_id`, [accountId]);
  return r.rows;
}

export async function closeOrder(orderId, c) {
  await pool.query('UPDATE orders SET status = $2 WHERE id = $1', [orderId, 'closed']);
  await pool.query(
    `INSERT INTO closes (order_id, slot_id, close_price, profit, swap, commission,
        duration_min, r_multiple, close_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orderId, c.slot_id, c.close_price, c.profit, c.swap, c.commission,
     c.duration_min, c.r_multiple, c.close_reason]);
}

export async function openRiskPct() {
  const r = await pool.query(
    `SELECT COALESCE(SUM(s.risk_pct), 0) AS total, COUNT(*) AS n
       FROM orders o JOIN signals s ON s.id = o.signal_id
      WHERE o.status = 'open'`);
  return { total: parseFloat(r.rows[0].total), n: parseInt(r.rows[0].n, 10) };
}

/**
 * Basisdrift per symbool. Dit is de meting die laat zien of je futures->CFD
 * omrekening stabiel is — en, als je op vertraagde data draait, hoeveel ruis
 * die vertraging in de entry zet.
 */
export async function basisDrift() {
  const r = await pool.query(
    `SELECT mt5_symbol,
            COUNT(*)::int                            AS n,
            ROUND(AVG(basis_pct) * 100, 4)           AS gem_basis_pct,
            ROUND(MIN(basis_pct) * 100, 4)           AS min_basis_pct,
            ROUND(MAX(basis_pct) * 100, 4)           AS max_basis_pct,
            ROUND(STDDEV_SAMP(basis_pct) * 100, 4)   AS sd_basis_pct
       FROM orders
      WHERE basis_pct IS NOT NULL
      GROUP BY mt5_symbol`);
  return r.rows;
}

export async function markMilestone(orderId, slotId, rLevel, price, minutes) {
  await pool.query(
    `INSERT INTO milestones (order_id, slot_id, r_level, price, minutes)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_id, r_level) DO NOTHING`,
    [orderId, slotId, rLevel, price, minutes]);
}

export async function milestonesFor(orderId) {
  const r = await pool.query(
    'SELECT r_level FROM milestones WHERE order_id = $1', [orderId]);
  return new Set(r.rows.map(x => parseFloat(x.r_level)));
}

export async function markInvalid(orderId, reason) {
  await pool.query('UPDATE orders SET valid = false, invalid_reason = $2 WHERE id = $1',
    [orderId, reason]);
}

export async function slotPerformance() {
  const r = await pool.query('SELECT * FROM slot_performance');
  return r.rows;
}
