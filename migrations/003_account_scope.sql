-- ═══════════════════════════════════════════════════════════════════════════
-- 003_account_scope.sql
--
-- Elke order hoort bij één MT5-account. Zonder dat veld gaat het mis zodra je
-- van account wisselt: de poller zoekt de oude position_id's op het NIEUWE
-- account, vindt ze niet, en boekt ze af als gesloten met lege cijfers. Je
-- slot-statistiek is dan vervuild zonder dat er een foutmelding komt.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE signals ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS orders_account_open
  ON orders (account_id, status) WHERE status = 'open';

-- Bestaande rijen hebben nog geen account. Zet ze op 'legacy' zodat de poller
-- ze met rust laat in plaats van ze verkeerd af te boeken.
UPDATE orders  SET account_id = 'legacy' WHERE account_id IS NULL;
UPDATE signals SET account_id = 'legacy' WHERE account_id IS NULL;

-- Prestatie per slot, nu ook uitsplitsbaar per account.
--
-- LET OP: CREATE OR REPLACE VIEW kan in Postgres géén kolommen hernoemen of
-- van volgorde wisselen — alleen achteraan toevoegen. account_id komt vooraan
-- te staan, dus de view moet eerst weg. Een view bevat geen data, dus dat is
-- gratis.
DROP VIEW IF EXISTS slot_performance;

CREATE VIEW slot_performance AS
SELECT
  o.account_id,
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
GROUP BY o.account_id, o.slot_id, o.mt5_symbol
ORDER BY total_profit DESC NULLS LAST;
