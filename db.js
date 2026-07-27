// ═══════════════════════════════════════════════════════════════════════════
// db.js — Postgres-laag. Alles wat naar de database gaat, gaat hierlangs.
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
  // Bijhouden wat er al gedraaid heeft. Zonder dit draait élk .sql-bestand bij
  // iedere herstart opnieuw — meestal onschuldig, maar niet als een latere
  // migratie een view of kolom herdefinieert. Dan draai je jezelf in een kringetje.
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

/**
 * Bouwt een INSERT uit één object. Kolomnamen en waarden komen daardoor uit
 * dezelfde bron en kunnen niet meer uit de pas lopen — precies de fout die
 * eerder een signaal kostte ("24 parameters, prepared statement requires 23").
 */
function bouwInsert(tabel, obj, extra = '') {
  const cols = Object.keys(obj);
  const ph   = cols.map((_, i) => `$${i + 1}`).join(',');
  return {
    sql: `INSERT INTO ${tabel} (${cols.join(',')}) VALUES (${ph}) ${extra}`,
    vals: cols.map(c => obj[c] ?? null),
  };
}

/** Schrijft het signaal weg. Botst het op de dag-index, dan is het een duplicate. */
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
    if (e.code === '23505') {                 // dit slot vuurde vandaag al
      const dup = bouwInsert('signals',
        { ...rij, status: 'duplicate', reason: 'slot vuurde vandaag al' });
      await pool.query(dup.sql, dup.vals);
      return { id: null, duplicate: true };
    }
    // Kolom bestaat nog niet (migratie niet gedraaid)? Log het duidelijk.
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
 * Volledige trade-feed voor het dashboard: elke order met zijn signaal
 * (voor sessie/orb-context) en zijn close (als hij al dicht is). Eén rij per
 * order, ongeacht of hij nog open staat, gesloten is, of mislukt is — het
 * dashboard filtert/sorteert dit clientside, dus hier gaat alles ruw mee.
 */
export async function tradesFeed(limit = 300) {
  const r = await pool.query(
    `SELECT o.id, o.placed_at, o.account_id, o.slot_id, o.mt5_symbol, o.action,
            o.status, o.valid, o.invalid_reason, o.entry_tv, o.fill_price,
            o.sl_price, o.tp_price, o.volume, o.risk_amount, o.equity_at_open,
            o.basis_pct, o.error,
            s.orb_start, s.risk_pct,
            c.closed_at, c.close_price, c.profit, c.swap, c.commission,
            c.duration_min, c.r_multiple, c.close_reason
       FROM orders o
       LEFT JOIN signals s ON s.id = o.signal_id
       LEFT JOIN closes  c ON c.order_id = o.id
      ORDER BY o.placed_at DESC
      LIMIT $1`, [limit]);
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

export async function startGhost(g) {
  await pool.query(
    `INSERT INTO ghosts (order_id, slot_id, mt5_symbol, direction, entry,
        sl_price, sl_points, tp_points, peak_price, peak_r, peak_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (order_id) DO NOTHING`,
    [g.order_id, g.slot_id, g.mt5_symbol, g.direction, g.entry,
     g.sl_price, g.sl_points, g.tp_points, g.peak_price, g.peak_r]);
}

export async function openGhosts() {
  const r = await pool.query('SELECT * FROM ghosts WHERE ended_at IS NULL');
  return r.rows;
}

export async function updateGhost(id, peakPrice, peakR) {
  await pool.query(
    `UPDATE ghosts SET peak_price = $2, peak_r = $3, peak_at = now()
      WHERE id = $1 AND ($3 > peak_r OR peak_r IS NULL)`, [id, peakPrice, peakR]);
}

export async function endGhost(id, reason, realisedR) {
  await pool.query(
    `UPDATE ghosts SET ended_at = now(), end_reason = $2,
            extra_r = GREATEST(COALESCE(peak_r,0) - $3, 0) WHERE id = $1`,
    [id, reason, realisedR ?? 0]);
}

export async function markInvalid(orderId, reason) {
  await pool.query('UPDATE orders SET valid = false, invalid_reason = $2 WHERE id = $1',
    [orderId, reason]);
}

export async function slotPerformance() {
  const r = await pool.query('SELECT * FROM slot_performance');
  return r.rows;
}

export async function ghostSummary() {
  const r = await pool.query('SELECT * FROM ghost_summary');
  return r.rows;
}
