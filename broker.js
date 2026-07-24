// ═══════════════════════════════════════════════════════════════════════════
// broker.js — MetaApi/MT5. Eén RPC-verbinding die open blijft.
// ═══════════════════════════════════════════════════════════════════════════
// LET OP: het standaard-import van dit pakket wijst naar de BROWSER-build.
// Die valt in Node om met "window is not defined". Voor Node ESM moet je het
// esm-node-subpad gebruiken — dat is geen detail, dat is het verschil tussen
// draaien en niet draaien.
import MetaApi from 'metaapi.cloud-sdk/esm-node';
import { SPECS, actieveSymbolen } from './session.js';

let connection = null;
let account    = null;
let lastErr    = null;          // waarom de verbinding niet lukte

export function lastError() { return lastErr; }

let currentAccountId = null;
/** Het account waar we NU op handelen. Wordt bij elke order meegeschreven. */
export function accountId() { return currentAccountId; }

export async function connect() {
  lastErr = null;

  // Accepteer meerdere schrijfwijzen. De variabelenaam is een stomme reden om
  // niet te kunnen handelen, dus we kijken gewoon naar alles wat het kan zijn.
  const token = process.env.META_API_TOKEN
             || process.env.METAAPI_TOKEN
             || process.env.META_TOKEN;
  const accountId = process.env.META_ACCOUNT_ID
                 || process.env.META_ACCOUNT
                 || process.env.METAAPI_ACCOUNT_ID
                 || process.env.METAAPI_ACCOUNT;

  if (!token || !accountId) {
    lastErr = `ontbrekende variabelen — token: ${token ? 'ok' : 'ONTBREEKT'}, ` +
              `account: ${accountId ? 'ok' : 'ONTBREEKT'}. ` +
              `Gezocht naar META_API_TOKEN / METAAPI_TOKEN en ` +
              `META_ACCOUNT_ID / META_ACCOUNT / METAAPI_ACCOUNT_ID.`;
    throw new Error(lastErr);
  }
  currentAccountId = String(accountId);
  console.log(`[MT5] account ${currentAccountId.slice(0, 8)}… , token ${token.length} tekens`);

  try {
    // Sommige tokens zijn aan een regio-domein gebonden. Staat META_BASE of
    // META_DOMAIN gezet, dan gebruiken we dat.
    const dom = process.env.META_DOMAIN || null;
    const api = dom ? new MetaApi(token, { domain: dom }) : new MetaApi(token);

    account = await api.metatraderAccountApi.getAccount(accountId);
    console.log(`[MT5] account gevonden: ${account.name || '(geen naam)'} — state ${account.state}`);

    if (account.state !== 'DEPLOYED') {
      console.log('[MT5] account niet deployed, deployen…');
      await account.deploy();
    }
    await account.waitConnected();

    connection = account.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();

    const info = await connection.getAccountInformation();
    console.log(`[MT5] verbonden — ${info.broker} | equity ${info.equity} ${info.currency}`);
    return info;

  } catch (e) {
    connection = null;
    lastErr = e.message || String(e);
    // MetaApi verpakt de echte reden vaak in details.
    if (e.details) lastErr += ' | details: ' + JSON.stringify(e.details).slice(0, 300);
    if (e.status)  lastErr += ` | http ${e.status}`;
    throw new Error(lastErr);
  }
}

/** Opnieuw proberen zonder herstart — handig na het corrigeren van een variabele. */
export async function reconnect() {
  connection = null;
  return await connect();
}

export function isReady() { return !!connection; }

export async function equity() {
  const info = await connection.getAccountInformation();
  return info.equity;
}

/**
 * Controleert de contractspecificaties in session.js tegen wat de broker zegt.
 * Een verkeerde tickValue geeft een verkeerde positiegrootte, en dat merk je
 * anders pas als er geld weg is.
 */
export async function verifySpecs() {
  const out = [];
  for (const sym of actieveSymbolen()) {
    const mine = SPECS[sym];
    if (!mine) { out.push(`${sym}: geen specificatie in session.js`); continue; }
    try {
      const s = await connection.getSymbolSpecification(sym);
      if (!s) { out.push(`${sym}: niet gevonden bij deze broker`); continue; }
      const checks = [
        ['volMin',  mine.volMin,  s.minVolume],
        ['volMax',  mine.volMax,  s.maxVolume],
        ['volStep', mine.volStep, s.volumeStep],
        ['tickSize', mine.tickSize, s.tickSize],
      ];
      for (const [naam, a, b] of checks) {
        if (b !== undefined && Math.abs(a - b) > 1e-9) {
          out.push(`${sym}.${naam}: session.js zegt ${a}, broker zegt ${b}`);
        }
      }
    } catch (e) { out.push(`${sym}: ${e.message}`); }
  }
  return out;
}

export async function quote(symbol) {
  const p = await connection.getSymbolPrice(symbol);
  return { ask: p.ask, bid: p.bid };
}

/**
 * Marktorder met SL en TP. De SL/TP worden hier berekend vanaf de WERKELIJKE
 * fill, niet vanaf de TradingView-prijs — futures en CFD lopen niet gelijk, en
 * alleen de afstanden (sl_points / tp_points) zijn overdraagbaar.
 */
export async function marketOrder({ symbol, action, volume, slPoints, tpPoints, comment, digits, ref: refIn }) {
  const long = action === 'buy';
  // `ref` komt meestal van de quote die de server net ophaalde om de omrekening
  // te doen. Zo worden SL en TP op precies dezelfde prijs gebaseerd als waarop
  // de percentages zijn toegepast — anders kruipt er drift tussen.
  let ref = refIn;
  if (!(ref > 0)) {
    const p = await connection.getSymbolPrice(symbol);
    ref = long ? p.ask : p.bid;
  }

  const round = v => +v.toFixed(digits ?? 2);
  const sl = round(long ? ref - slPoints : ref + slPoints);
  const tp = round(long ? ref + tpPoints : ref - tpPoints);

  const opts = { comment: String(comment || '').slice(0, 26) };
  const res = long
    ? await connection.createMarketBuyOrder(symbol, volume, sl, tp, opts)
    : await connection.createMarketSellOrder(symbol, volume, sl, tp, opts);

  return {
    orderId:    res.orderId,
    positionId: res.positionId || res.orderId,
    fill:       ref,
    sl, tp,
    raw: res,
  };
}

export async function positions() {
  return await connection.getPositions();
}

export async function closePosition(positionId) {
  return await connection.closePosition(positionId, {});
}

/** Afgesloten deals uit de geschiedenis, om de close-prijs en winst op te halen. */
export async function historyForPosition(positionId, sinceMs) {
  const from = new Date(sinceMs - 60_000);
  const to   = new Date(Date.now() + 60_000);
  const deals = await connection.getDealsByTimeRange(from, to);
  return (deals?.deals || deals || []).filter(d => String(d.positionId) === String(positionId));
}
