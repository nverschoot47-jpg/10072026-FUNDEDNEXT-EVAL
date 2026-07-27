-- ═══════════════════════════════════════════════════════════════════════════
-- 005_valid_column.sql
--
-- server.js schrijft sinds guard.checkData() een `valid` en `invalid_reason`
-- veld naar elke order — maar geen enkele migratie heeft die kolommen ooit
-- aangemaakt. Het gevolg: db.insertOrder() faalt op ELKE trade met
-- "column \"valid\" of relation \"orders\" does not exist", en dus wordt er
-- helemaal niets meer geplaatst sinds guard.js in gebruik kwam.
--
-- Puur additief (ADD COLUMN IF NOT EXISTS) — bestaande rijen blijven ongemoeid
-- en krijgen valid = true (de default), wat correct is: ze zijn geplaatst vóór
-- er een datavaliditeitscheck bestond, dus er is niets bekend dat ze ongeldig
-- maakt.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS valid          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS invalid_reason TEXT;

CREATE INDEX IF NOT EXISTS orders_invalid ON orders (valid) WHERE valid = false;
