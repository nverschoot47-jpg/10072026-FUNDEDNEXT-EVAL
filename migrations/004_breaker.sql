-- ═══════════════════════════════════════════════════════════════════════════
-- 004_breaker.sql
--
-- Stand van de circuit breaker (guard.js). Eén rij, altijd. De breaker moet
-- een herstart of nieuwe deploy overleven — anders staat hij na elke crash weer
-- vanzelf op "normaal" en is hij als veiligheidsmechanisme waardeloos.
--
-- De singleton wordt afgedwongen door een BOOLEAN-primary-key met CHECK (id):
-- er kan maar één rij bestaan waarvoor id = true.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS breaker (
  id         BOOLEAN     PRIMARY KEY DEFAULT true,
  tripped    BOOLEAN     NOT NULL DEFAULT false,
  reason     TEXT,
  since      TIMESTAMPTZ,                       -- moment van eerste trip; NULL als niet getript
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT breaker_singleton CHECK (id)
);

-- Beginstand: breaker uit. Bestaat de rij al, laat 'm dan met rust.
INSERT INTO breaker (id, tripped) VALUES (true, false)
  ON CONFLICT (id) DO NOTHING;
