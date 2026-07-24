-- ═══════════════════════════════════════════════════════════════════════════
-- 002_cfd_conversion.sql
--
-- Het signaal komt van een futures-chart (MGC1! / MNQ1!), de order gaat naar een
-- CFD (XAUUSD / NDX100). Daar zit een basis tussen — bij Nasdaq bijna 1.7%.
-- Afstanden zijn daarom NIET één-op-één overdraagbaar: ze moeten als percentage
-- van de prijs worden meegenomen.
--
-- Deze kolommen bewaren beide werelden naast elkaar, zodat je achteraf kunt
-- zien wat TradingView zei én wat er werkelijk op MT5 stond.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS sl_pct        NUMERIC(12,8),   -- sl_points / entry_tv
  ADD COLUMN IF NOT EXISTS tp_pct        NUMERIC(12,8);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS basis         NUMERIC(18,5),   -- mt5_ref - entry_tv
  ADD COLUMN IF NOT EXISTS basis_pct     NUMERIC(12,8),   -- mt5_ref / entry_tv - 1
  ADD COLUMN IF NOT EXISTS sl_pct        NUMERIC(12,8),
  ADD COLUMN IF NOT EXISTS tp_pct        NUMERIC(12,8),
  ADD COLUMN IF NOT EXISTS sl_points_tv  NUMERIC(18,5),   -- zoals TradingView hem stuurde
  ADD COLUMN IF NOT EXISTS tp_points_tv  NUMERIC(18,5),
  ADD COLUMN IF NOT EXISTS orb_high_mt5  NUMERIC(18,5),   -- omgerekend naar CFD-schaal
  ADD COLUMN IF NOT EXISTS orb_low_mt5   NUMERIC(18,5),
  ADD COLUMN IF NOT EXISTS vwap_mt5      NUMERIC(18,5);

-- sl_points / tp_points in `orders` zijn vanaf nu ALTIJD de MT5-afstanden.
-- De originele futures-afstanden staan in sl_points_tv / tp_points_tv.

COMMENT ON COLUMN orders.sl_points     IS 'stopafstand in MT5-prijs-eenheden (percentage toegepast op de fill)';
COMMENT ON COLUMN orders.sl_points_tv  IS 'stopafstand zoals TradingView hem stuurde, futures-schaal';
COMMENT ON COLUMN orders.basis_pct     IS 'relatief verschil futures->CFD op het moment van de order';

CREATE OR REPLACE VIEW basis_drift AS
SELECT mt5_symbol,
       COUNT(*)                                   AS n,
       ROUND(AVG(basis_pct) * 100, 4)             AS gem_basis_pct,
       ROUND(MIN(basis_pct) * 100, 4)             AS min_basis_pct,
       ROUND(MAX(basis_pct) * 100, 4)             AS max_basis_pct,
       ROUND(AVG(sl_points - sl_points_tv), 5)    AS gem_stop_correctie
FROM orders
WHERE basis_pct IS NOT NULL
GROUP BY mt5_symbol;
