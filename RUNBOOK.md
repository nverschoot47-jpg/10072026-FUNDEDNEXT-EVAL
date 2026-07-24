# RUNBOOK

## Deploy
```
git push            # Railway bouwt automatisch
```
Bootlog moet tonen:
```
[DB] 001_init.sql toegepast
[MT5] verbonden — <broker> | equity <bedrag> USD
[MT5] contractspecificaties komen overeen met session.js
[Tracker] actief, elke 60s
[PRONTO ORB] firm=fundednext luistert op 3000
```

## Webhook testen zonder TradingView
```bash
curl -X POST "https://<app>.up.railway.app/webhook?secret=<SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"orders":[{
    "action":"buy","symbol":"MGC1!","slot_id":"TEST-0230-20m-x2-met-2R",
    "entry":4050.0,"sl_points":13.5,"tp_points":27.0,"risk_pct":0.25
  }]}'
```
Zet eerst `TRADING_ENABLED=false` — dan wordt alles gelogd en niets verstuurd.

## Veelvoorkomend

**401** → `secret` in de URL komt niet overeen met `WEBHOOK_SECRET`.

**`geen symboolmapping voor X`** → ticker staat niet in `session.js` → `FIRMS`.

**`onder volMin`** → risicobedrag te klein voor de stopafstand. Verhoog
`risk_pct`, of accepteer dat dit slot bij deze accountgrootte niet kan.

**`MAX_RISK_PCT_TOTAL bereikt`** → te veel openstaand risico. Verwacht bij
onbeperkte houdtijd; verhoog de grens of sluit posities.

**Specs wijken af** → broker heeft andere `volMin`/`volStep`/`tickSize` dan
`session.js`. Pas `SPECS` aan; laat het niet staan.

## Nuttige queries
```sql
-- vandaag geweigerd, met reden
SELECT slot_id, status, reason FROM signals
WHERE trade_date = CURRENT_DATE AND status <> 'accepted';

-- per slot
SELECT * FROM slot_performance;

-- slippage tegen stopafstand
SELECT slot_id, AVG(ABS(slippage)) AS slip, AVG(sl_points) AS stop,
       ROUND(100*AVG(ABS(slippage))/NULLIF(AVG(sl_points),0),2) AS pct
FROM orders WHERE fill_price IS NOT NULL GROUP BY slot_id;

-- swap tegen winst
SELECT slot_id, SUM(profit) AS winst, SUM(swap) AS swap FROM closes GROUP BY slot_id;
```
