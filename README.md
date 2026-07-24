# PRONTO ORB bridge — TradingView → Railway → MetaApi → MT5

Ontvangt de webhook van `PRONTO_ORB_multislot_live`, zet elke order door naar
MT5 via MetaApi, en logt alles onderweg in Postgres.

```
TradingView alert  (MGC1! / MNQ1!, één bericht per bar)
        │  POST /webhook?secret=...
        │  {"orders":[ {...}, {...} ]}
        ▼
   server.js   valideren → symbool mappen → dedup → risicoremmen
        │
        ├─ equity ophalen bij MT5
        ├─ lots = risk% × equity ÷ (sl_points × waarde per prijs-eenheid)
        ├─ marktorder met SL en TP, berekend vanaf de ECHTE fill
        ├─ alles wegschrijven: signals / orders (incl. slippage)
        ▼
   tracker.js  poll elke 60s → gesloten posities → closes (winst, R, duur, reden)
```

## Bestanden

| Bestand | Doel |
|---|---|
| `server.js` | webhook, validatie, risicoremmen, order plaatsen |
| `session.js` | **de enige plek met instellingen** — symbolen, specs, sizing |
| `broker.js` | MetaApi-verbinding, quotes, orders, historie |
| `tracker.js` | poller die uitkomsten wegschrijft |
| `db.js` | Postgres-laag |
| `migrate.js` | schema los draaien |
| `migrations/001_init.sql` | tabellen + `slot_performance` view |

## Railway

1. Nieuw project → deploy from GitHub repo
2. **+ New → Database → PostgreSQL** (zet `DATABASE_URL` automatisch)
3. Variables uit `.env.example` invullen
4. Webhook-URL: `https://<app>.up.railway.app/webhook?secret=<WEBHOOK_SECRET>`

Zet in TradingView: alert op `PRONTO ORB · Multi-Slot Live` → **Any alert()
function call** → webhook aan → **berichtveld leeg laten**.

## Wat het bewust NIET doet

**`sl_points` wordt niet aangepast.** De PineScript rekent de stopafstand al
volledig uit (ORB-afstand × multiplier). Er wordt hier geen buffer overheen
gelegd — dat zou de gemeten strategie veranderen.

**`entry`, `sl` en `tp` uit de payload worden alleen gelogd.** MGC1! en XAUUSD
zijn niet hetzelfde instrument; er zit een basis tussen futures en CFD. Alleen
de *afstanden* zijn overdraagbaar, dus SL en TP worden opnieuw berekend vanaf de
werkelijke MT5-fill.

**Houdtijd is onbegrensd.** Een positie loopt tot SL of TP. `expires_at` wordt
gelogd maar niet afgedwongen, tenzij je `ENFORCE_EXPIRY=true` zet.

## Waar stel je het risico in?

Op drie plekken, met deze voorrang:

| Plek | Werkt op | Wijzigen |
|---|---|---|
| `RISK_PCT_OVERRIDE` (Railway) | **alles, wint altijd** | variabele opslaan, geen redeploy |
| `risk_pct` in de webhook | per slot | PineScript-input `Risk % per trade` |
| `DEFAULT_RISK_PCT` | alleen als de payload niets meestuurt | Railway |

`railway.toml` doet hier niets aan mee — dat is uitsluitend build- en
deploy-configuratie. Variabelen horen in het tabblad **Variables**.

Wil je snel terug in risico: zet `RISK_PCT_OVERRIDE=0.1` en sla op. Elke
volgende order gebruikt 0,1%, ongeacht wat TradingView stuurt. Veld weer
leegmaken en de payload telt weer.

`/health` toont welke van de drie momenteel actief is.

## Remmen

Met onbeperkte houdtijd stapelen posities op. Twee grenzen:

- `MAX_OPEN_POSITIONS` — aantal tegelijk open
- `MAX_RISK_PCT_TOTAL` — som van `risk_pct` over alle open posities

Wordt een van beide geraakt, dan wordt het signaal geweigerd en met reden
gelogd. Niets gaat stilletjes verloren.

## Eindpunten

| Route | Doel |
|---|---|
| `POST /webhook?secret=` | ontvangt TradingView |
| `GET /health` | verbinding, open posities, gebruikt risico |
| `GET /slots` | per slot: n, winst, win%, gem. R, gem. slippage |

## Controles na de eerste dag

1. `/health` — staat `broker: true`?
2. Bootlog — komen de contractspecificaties overeen met `session.js`? Een
   afwijkende `tickValue` betekent verkeerde positiegroottes.
3. `/slots` — vergelijk `avg_slippage` met je stopafstand. Is slippage een
   noemenswaardig deel van `sl_points`, dan is de live-uitkomst structureel
   slechter dan de backtest.
4. `signals WHERE status <> 'accepted'` — wat werd geweigerd en waarom.

## Swap

FundedNext rekent swap in punten per dag. Bij open-eind posities telt dat op:

| symbool | long | short |
|---|---|---|
| XAUUSD | −57.94 | −15.70 |
| NDX100 | −329.38 | **+62.82** |

Longs op NDX100 betalen, shorts ontvangen. Bij lange houdtijden wordt dat een
serieuze post die in geen enkele backtest zit. `closes.swap` houdt bij wat het
werkelijk gekost heeft — vergelijk dat na een maand met `closes.profit`.
