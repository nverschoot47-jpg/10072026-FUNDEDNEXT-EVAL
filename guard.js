// ═══════════════════════════════════════════════════════════════════════════
// guard.js — circuit breaker + datavaliditeit.
//
// Twee dingen die los van de handelslogica staan maar wél elke order raken:
//
//   1. De circuit breaker. Staat hij om, dan worden signalen nog gelogd maar
//      niet meer geplaatst. De stand staat in Postgres (tabel `breaker`), zodat
//      een herstart of nieuwe deploy hem niet stilletjes weer aanzet — een
//      breaker die zichzelf vergeet is geen breaker.
//
//   2. checkData(). Draait ná de fill en bepaalt of een order mág meetellen in
//      de statistiek. De order is dan al geplaatst; dit markeert alleen of de
//      cijfers te vertrouwen zijn (bv. futures→CFD-conversie met te grote basis).
//
// Vereist migratie 004_breaker.sql. db.initSchema() draait die bij het opstarten.
// ═══════════════════════════════════════════════════════════════════════════
import * as db from './db.js';

// Zachte databovengrens voor de statistiek. Ligt onder de harde MAX_BASIS_PCT
// die server.js al vóór de order weigert: een trade tussen deze twee grenzen
// wordt dus wél geplaatst maar telt niet mee. basisPct is een fractie (0.02 = 2%),
// vandaar ×100 — precies zoals server.js het vergelijkt.
const DATA_MAX_BASIS_PCT = parseFloat(process.env.DATA_MAX_BASIS_PCT || '3');

// status() wordt bij elke order én elke dashboard-refresh (15s) aangeroepen.
// Een korte cache scheelt een query per order zonder de stand merkbaar te
// laten verouderen. trip()/reset() gooien de cache meteen weg.
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 2000;

/**
 * Huidige stand van de breaker.
 * @returns {Promise<{tripped: boolean, reason: string|null, since: Date|null}>}
 */
export async function status() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;

  try {
    const r = await db.pool.query(
      'SELECT tripped, reason, since FROM breaker WHERE id = true');
    const row = r.rows[0] ?? { tripped: false, reason: null, since: null };
    _cache = {
      tripped: row.tripped === true,
      reason:  row.reason ?? null,
      since:   row.since ?? null,
    };
    _cacheAt = now;
  } catch (e) {
    // Kan de stand niet lezen (migratie 004 nog niet gedraaid, of DB even weg)?
    // Fail-safe: níét handelen liever dan blind doorhandelen met onbekende
    // breaker-status. Dit persisteren we bewust NIET — zodra de DB terug is,
    // geeft status() vanzelf weer de echte stand. De cache slaan we over.
    await db.logError('guard', `breaker-status onleesbaar: ${e.message}`);
    return { tripped: true, reason: `breaker-status onleesbaar: ${e.message}`, since: new Date() };
  }

  return _cache;
}

/**
 * Zet de breaker om. Bestaande trip-tijd blijft staan; een nieuwe reden
 * overschrijft de oude.
 */
export async function trip(reason) {
  _cache = null;
  await db.pool.query(
    `INSERT INTO breaker (id, tripped, reason, since, updated_at)
     VALUES (true, true, $1, now(), now())
     ON CONFLICT (id) DO UPDATE
        SET tripped    = true,
            reason     = EXCLUDED.reason,
            since      = COALESCE(breaker.since, now()),
            updated_at = now()`,
    [reason ?? null]);
  console.warn(`[Guard] BREAKER GETRIPT — ${reason ?? 'geen reden'}`);
}

/** Zet de breaker terug op normaal en wist de trip-tijd. */
export async function reset(reason) {
  _cache = null;
  await db.pool.query(
    `INSERT INTO breaker (id, tripped, reason, since, updated_at)
     VALUES (true, false, $1, NULL, now())
     ON CONFLICT (id) DO UPDATE
        SET tripped    = false,
            reason     = EXCLUDED.reason,
            since      = NULL,
            updated_at = now()`,
    [reason ?? null]);
  console.log(`[Guard] breaker gereset — ${reason ?? ''}`);
}

/**
 * Beoordeelt of een geplaatste order mag meetellen in de statistiek.
 * De order is op dit punt al gevuld; dit markeert alleen de datavaliditeit.
 *
 * @param {object} o  de order (nu niet gebruikt, wél in de signatuur zodat
 *                     latere per-order checks er zonder aanroepwijziging bij kunnen)
 * @param {{conversieGeschaald: boolean, basisPct: number|null}} ctx
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkData(o, { conversieGeschaald, basisPct } = {}) {
  const reasons = [];

  if (conversieGeschaald) {
    if (basisPct === null || basisPct === undefined || Number.isNaN(basisPct)) {
      // Geschaald maar geen basis: de conversie leunt op een verhouding die we
      // niet konden meten. Cijfers niet te vertrouwen.
      reasons.push('conversie geschaald maar basis onbekend');
    } else if (Math.abs(basisPct * 100) > DATA_MAX_BASIS_PCT) {
      reasons.push(
        `basis ${(basisPct * 100).toFixed(2)}% > DATA_MAX_BASIS_PCT ${DATA_MAX_BASIS_PCT}%`);
    }
  }

  return { valid: reasons.length === 0, reasons };
}
