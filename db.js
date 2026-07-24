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
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await pool.query(sql);
    console.log(`[DB] ${f} toegepast`);
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

/** Schrijft het signaal weg. Botst het op de dag-index, dan is het een duplicate. */
export async function insertSignal(firm, o, mt5Symbol, status, reason) {
  const cols = ['firm','slot_id','slot','trade_no','action','tv_symbol','mt5_symbol',
    'entry_tv','sl_points','tp_points','rr','sl_mult','orb_start','orb_minutes',
    'orb_high','orb_low','vwap_side','vwap','risk_pct','expires_at','status','reason','raw'];
  const vals = [firm, o.slot_id, o.slot ?? null, o.trade_no ?? null, o.action, o.symbol, mt5Symbol,
    o.entry ?? null, o.sl_points ?? null, o.tp_points ?? null, o.rr ?? null, o.sl_mult ?? null,
    o.orb_start ?? null, o.orb_minutes ?? null, o.orb_high ?? null, o.orb_low ?? null,
    o.vwap_side ?? null, o.vwap ?? null, o.risk_pct ?? null, o.expires_at ?? null,
    status, reason ?? null, JSON.stringify(o), o.__account ?? null];
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const q  = `INSERT INTO signals (${cols.join(',')}) VALUES (${ph}) RETURNING id`;

  try {
    const r = await pool.query(q, vals);
    return { id: r.rows[0].id, duplicate: false };
  } catch (e) {
    if (e.code === '23505') {          // dit slot vuurde vandaag al
      const dup = [...vals];
      dup[cols.indexOf('status')] = 'duplicate';
      dup[cols.indexOf('reason')] = 'slot vuurde vandaag al';
      await pool.query(q, dup);
      return { id: null, duplicate: true };
    }
    throw e;
  }
}

export async function insertOrder(row) {
  const cols = ['signal_id','firm','slot_id','mt5_symbol','action','volume',
    'entry_tv','fill_price','slippage','sl_price','tp_price','sl_points','tp_points',
    'sl_points_tv','tp_points_tv','sl_pct','tp_pct','basis','basis_pct',
    'orb_high_mt5','orb_low_mt5','vwap_mt5',
    'risk_amount','equity_at_open','position_id','mt5_order_id','status','error','account_id'];
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const r = await pool.query(
    `INSERT INTO orders (${cols.join(',')}) VALUES (${ph}) RETURNING id`,
    cols.map(c => row[c] ?? null));
  return r.rows[0].id;
}

/** Alleen de open orders van HET HUIDIGE account. Rijen van een vorig account
 *  blijven met rust — die posities bestaan hier niet en zouden verkeerd
 *  worden afgeboekt. */
export async function openOrders(accountId) {
  const r = await pool.query(
    `SELECT id, slot_id, mt5_symbol, action, volume, fill_price, sl_price, tp_price,
            sl_points, risk_amount, position_id, placed_at
       FROM orders
      WHERE status = 'open' AND position_id IS NOT NULL
        AND account_id IS NOT DISTINCT FROM $1`, [accountId]);
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

export async function slotPerformance() {
  const r = await pool.query('SELECT * FROM slot_performance');
  return r.rows;
}
