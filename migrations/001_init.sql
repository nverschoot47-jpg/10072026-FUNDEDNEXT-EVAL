-- ═══════════════════════════════════════════════════════════════════════════
-- 001_init.sql — volledige logging van TradingView tot MT5-close
--
--   signals   elke binnenkomende order uit de webhook, ook geweigerde
--   orders    wat er daadwerkelijk naar MT5 ging, met fill en slippage
--   closes    hoe de positie afliep, met R-multiple
--   errors    alles wat stukliep, met de ruwe payload erbij
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS signals (
  id            BIGSERIAL PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  trade_date    DATE        NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  firm          TEXT        NOT NULL,

  slot_id       TEXT        NOT NULL,
  slot          INT,
  trade_no      INT,
  action        TEXT        NOT NULL,
  tv_symbol     TEXT        NOT NULL,
  mt5_symbol    TEXT,

  entry_tv      NUMERIC(18,5),
  sl_points     NUMERIC(18,5),
  tp_points     NUMERIC(18,5),
  rr            NUMERIC(6,2),
  sl_mult       NUMERIC(6,2),

  orb_start     TEXT,
  orb_minutes   INT,
  orb_high      NUMERIC(18,5),
  orb_low       NUMERIC(18,5),
  vwap_side     TEXT,
  vwap          NUMERIC(18,5),
  risk_pct      NUMERIC(6,3),
  expires_at    TIMESTAMPTZ,

  status        TEXT        NOT NULL,   -- accepted | rejected | duplicate | error
  reason        TEXT,
  raw           JSONB       NOT NULL
);

-- Eén slot mag per dag één keer vuren. Een herhaalde webhook botst hierop en
-- wordt als duplicate weggeschreven in plaats van dubbel gevuld.
CREATE UNIQUE INDEX IF NOT EXISTS signals_slot_day
  ON signals (slot_id, trade_date)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS signals_received ON signals (received_at DESC);
CREATE INDEX IF NOT EXISTS signals_slot     ON signals (slot_id);

CREATE TABLE IF NOT EXISTS orders (
  id             BIGSERIAL PRIMARY KEY,
  signal_id      BIGINT REFERENCES signals(id) ON DELETE CASCADE,
  placed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  firm           TEXT NOT NULL,
  slot_id        TEXT NOT NULL,

  mt5_symbol     TEXT NOT NULL,
  action         TEXT NOT NULL,
  volume         NUMERIC(12,4) NOT NULL,

  entry_tv       NUMERIC(18,5),   -- prijs volgens TradingView
  fill_price     NUMERIC(18,5),   -- werkelijke MT5-fill
  slippage       NUMERIC(18,5),   -- fill - tv, in prijs-eenheden

  sl_price       NUMERIC(18,5),
  tp_price       NUMERIC(18,5),
  sl_points      NUMERIC(18,5),
  tp_points      NUMERIC(18,5),
  risk_amount    NUMERIC(18,2),
  equity_at_open NUMERIC(18,2),

  position_id    TEXT,
  mt5_order_id   TEXT,
  status         TEXT NOT NULL DEFAULT 'open',   -- open | closed | failed
  error          TEXT
);

CREATE INDEX IF NOT EXISTS orders_open ON orders (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS orders_slot ON orders (slot_id);

CREATE TABLE IF NOT EXISTS closes (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  closed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  slot_id       TEXT NOT NULL,
  close_price   NUMERIC(18,5),
  profit        NUMERIC(18,2),      -- inclusief swap en commissie zoals MT5 hem geeft
  swap          NUMERIC(18,2),
  commission    NUMERIC(18,2),
  duration_min  INT,
  r_multiple    NUMERIC(8,3),       -- winst / oorspronkelijk risicobedrag
  close_reason  TEXT                -- tp | sl | expiry | manual | unknown
);

CREATE INDEX IF NOT EXISTS closes_slot ON closes (slot_id);

CREATE TABLE IF NOT EXISTS errors (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  context    TEXT,
  message    TEXT,
  payload    JSONB
);

-- Per slot: hoeveel getriggerd, hoeveel gesloten, gemiddelde R.
-- DROP eerst: 003 hangt er een kolom vóór, en CREATE OR REPLACE kan kolommen
-- niet hernoemen. Zonder deze regel klapt een herstart eruit.
DROP VIEW IF EXISTS slot_performance;

CREATE VIEW slot_performance AS
SELECT
  o.slot_id,
  o.mt5_symbol,
  COUNT(*)                                             AS n_orders,
  COUNT(c.id)                                          AS n_closed,
  ROUND(AVG(c.r_multiple), 3)                          AS avg_r,
  ROUND(SUM(c.profit), 2)                              AS total_profit,
  ROUND(100.0 * COUNT(*) FILTER (WHERE c.r_multiple > 0)
        / NULLIF(COUNT(c.id), 0), 1)                   AS win_pct,
  ROUND(AVG(c.duration_min))                           AS avg_minutes,
  ROUND(AVG(ABS(o.slippage)), 5)                       AS avg_slippage
FROM orders o
LEFT JOIN closes c ON c.order_id = o.id
GROUP BY o.slot_id, o.mt5_symbol
ORDER BY total_profit DESC NULLS LAST;
