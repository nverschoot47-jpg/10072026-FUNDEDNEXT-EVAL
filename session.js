// ═══════════════════════════════════════════════════════════════════════════
// session.js — alle configuratie op één plek
//
// Hier staat WAT er verhandeld wordt en HOE groot. De rest van de app leest
// alleen uit dit bestand; je hoeft nergens anders te zoeken als een symbool
// verandert of een broker andere contractspecificaties heeft.
// ═══════════════════════════════════════════════════════════════════════════

export const FIRM             = process.env.FIRM || 'fundednext';
export const TRADING_ENABLED  = (process.env.TRADING_ENABLED ?? 'true') === 'true';
export const ENFORCE_EXPIRY   = (process.env.ENFORCE_EXPIRY ?? 'false') === 'true';
export const MAX_OPEN         = parseInt(process.env.MAX_OPEN_POSITIONS  || '40', 10);
export const MAX_RISK_TOTAL   = parseFloat(process.env.MAX_RISK_PCT_TOTAL || '10');
export const DEFAULT_RISK_PCT = parseFloat(process.env.DEFAULT_RISK_PCT   || '0.25');
export const TRACK_INTERVAL   = parseInt(process.env.TRACK_INTERVAL_SEC  || '60', 10) * 1000;
// Maximaal toegestaan verschil tussen de futures-prijs van TradingView en de
// CFD-prijs van de broker. Klopt de mapping niet (MGC1! -> een Nasdaq-symbool),
// dan is dat verschil enorm en wordt de order geweigerd in plaats van geplaatst.
export const MAX_BASIS_PCT    = parseFloat(process.env.MAX_BASIS_PCT || '5');

// ── Symboolvertaling ───────────────────────────────────────────────────────
// TradingView handelt in futures (MGC1!, MNQ1!), de prop firm in CFD's. De
// prijzen liggen dicht bij elkaar maar zijn niet identiek: er zit een basis
// tussen futures en spot. sl_points en tp_points uit de PineScript zijn
// AFSTANDEN, geen niveaus — die vertalen wél één-op-één. De absolute `entry`,
// `sl` en `tp` uit de payload zijn daarom alleen logging; de echte SL/TP
// worden hier herrekend vanaf de werkelijke MT5-fill.
const FIRMS = {
  fundednext: {
    label: 'FundedNext',
    symbols: {
      'MGC1!': 'XAUUSD',
      'MNQ1!': 'NDX100',
    },
  },
  // Voorbeeld voor een tweede firm — vul in zodra je er een toevoegt.
  ftmo: {
    label: 'FTMO',
    symbols: {
      'MGC1!': 'XAUUSD',
      'MNQ1!': 'US100.cash',
    },
  },
};

// ── Contractspecificaties ──────────────────────────────────────────────────
// Overgenomen uit het MT5 symbool-informatiescherm. De poller controleert deze
// bij het opstarten tegen wat MetaApi teruggeeft en waarschuwt bij verschil —
// een verkeerde tickValue betekent een verkeerde positiegrootte, en dat merk je
// anders pas als het misgaat.
export const SPECS = {
  XAUUSD: { tickSize: 0.01, tickValue: 1.0, volMin: 0.01, volMax: 50, volStep: 0.01, digits: 2 },
  NDX100: { tickSize: 0.01, tickValue: 0.1, volMin: 0.01, volMax: 40, volStep: 0.01, digits: 2 },
  'US100.cash': { tickSize: 0.01, tickValue: 0.1, volMin: 0.01, volMax: 40, volStep: 0.01, digits: 2 },
};

export function firmConfig() {
  const f = FIRMS[FIRM];
  if (!f) throw new Error(`Onbekende FIRM "${FIRM}". Bekend: ${Object.keys(FIRMS).join(', ')}`);
  return f;
}

/** TradingView-ticker -> MT5-symbool. Onbekend = null (signaal wordt geweigerd). */
export function mapSymbol(tvSymbol) {
  const f = firmConfig();
  return f.symbols[tvSymbol] || f.symbols[String(tvSymbol).toUpperCase()] || null;
}

/**
 * Positiegrootte uit risico en stopafstand.
 *
 *   waarde van 1.0 prijsbeweging per lot = tickValue / tickSize
 *   XAUUSD : 1.00 / 0.01 = 100 USD per 1.00 dollar goudbeweging per lot
 *   NDX100 : 0.10 / 0.01 =  10 USD per 1.00 indexpunt per lot
 *
 * lots = risicobedrag / (stopafstand × waarde per prijsbeweging)
 */
export function calcLots({ symbol, equity, riskPct, slPoints }) {
  const spec = SPECS[symbol];
  if (!spec) return { lots: null, reason: `geen contractspecificatie voor ${symbol}` };
  if (!(slPoints > 0)) return { lots: null, reason: `ongeldige sl_points: ${slPoints}` };

  const riskAmount   = equity * (riskPct / 100);
  const valuePerUnit = spec.tickValue / spec.tickSize;
  const raw          = riskAmount / (slPoints * valuePerUnit);

  // Naar beneden afronden op volStep: liever iets minder risico dan iets meer.
  const steps   = Math.floor(raw / spec.volStep);
  let   lots    = +(steps * spec.volStep).toFixed(8);

  if (lots < spec.volMin) {
    return {
      lots: null,
      reason: `berekende omvang ${raw.toFixed(4)} ligt onder volMin ${spec.volMin} ` +
              `(risico ${riskAmount.toFixed(2)} bij stop ${slPoints})`,
    };
  }
  if (lots > spec.volMax) lots = spec.volMax;

  return { lots, riskAmount, valuePerUnit, raw };
}

/** Bedrag dat één prijsbeweging waard is — gebruikt om R uit te rekenen bij close. */
export function valuePerUnit(symbol) {
  const spec = SPECS[symbol];
  return spec ? spec.tickValue / spec.tickSize : null;
}

/**
 * Futures -> CFD omrekening.
 *
 * TradingView rekent op MGC1! / MNQ1!, de order gaat naar XAUUSD / NDX100.
 * Daar zit een basis tussen: bij goud een paar tienden van een procent, bij
 * Nasdaq al snel 1,5–2%. Een stopafstand van 100 futurespunten is op de CFD dus
 * NIET 100 punten — hij is 100/28620 = 0,3494% van de prijs, en dat percentage
 * toegepast op 29100 geeft 101,7 punten.
 *
 * Daarom wordt alles als PERCENTAGE overgezet en pas op de werkelijke MT5-prijs
 * weer in punten omgerekend. De multiplier zit al in sl_points verwerkt door de
 * PineScript; hier wordt alleen geschaald, nooit vermenigvuldigd.
 */
export function convertToMt5({ tvEntry, mt5Ref, slPointsTv, tpPointsTv }) {
  const tv = parseFloat(tvEntry);
  if (!(tv > 0) || !(mt5Ref > 0)) {
    // Zonder geldige TV-prijs kunnen we niet schalen; dan maar 1-op-1, en dat
    // wordt zo gelogd zodat het achteraf zichtbaar is.
    return {
      ratio: 1, basis: null, basisPct: null,
      slPct: null, tpPct: null,
      slPointsMt5: slPointsTv, tpPointsMt5: tpPointsTv,
      scaled: false,
    };
  }
  const ratio    = mt5Ref / tv;
  const slPct    = slPointsTv / tv;          // fractie van de prijs
  const tpPct    = tpPointsTv / tv;
  return {
    ratio,
    basis:    +(mt5Ref - tv).toFixed(5),
    basisPct: +(ratio - 1).toFixed(8),
    slPct:    +slPct.toFixed(8),
    tpPct:    +tpPct.toFixed(8),
    slPointsMt5: +(mt5Ref * slPct).toFixed(5),
    tpPointsMt5: +(mt5Ref * tpPct).toFixed(5),
    scaled: true,
  };
}

/** Schaalt een los prijsniveau (ORB-hoog, VWAP, ...) mee naar CFD-schaal. */
export function scaleLevel(level, ratio) {
  const v = parseFloat(level);
  return (v > 0 && ratio > 0) ? +(v * ratio).toFixed(5) : null;
}
