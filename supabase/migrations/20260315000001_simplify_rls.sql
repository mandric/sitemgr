-- Phase 2: Simplify RLS policies to user_id-only with performance optimizations
-- Drops phone_number-based auth paths
-- Uses (SELECT auth.uid()) for initPlan caching and TO authenticated for anon blocking

-- ── bucket_configs ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own bucket configs" ON bucket_configs;
DROP POLICY IF EXISTS "Users can insert own bucket configs" ON bucket_configs;
DROP POLICY IF EXISTS "Users can update own bucket configs" ON bucket_configs;
DROP POLICY IF EXISTS "Users can delete own bucket configs" ON bucket_configs;

CREATE POLICY "Users can view own bucket configs"
ON bucket_configs FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own bucket configs"
ON bucket_configs FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own bucket configs"
ON bucket_configs FOR UPDATE
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own bucket configs"
ON bucket_configs FOR DELETE
TO authenticated
USING ((SELECT auth.uid()) = user_id);

-- ── events ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own events" ON events;
DROP POLICY IF EXISTS "Users can insert own events" ON events;

CREATE POLICY "Users can view own events"
ON events FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own events"
ON events FOR INSERT
TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);

-- ── watched_keys ───────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own watched keys" ON watched_keys;
DROP POLICY IF EXISTS "Users can manage own watched keys" ON watched_keys;

CREATE POLICY "Users can view own watched keys"
ON watched_keys FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can manage own watched keys"
ON watched_keys FOR ALL
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

-- ── enrichments ────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own enrichments" ON enrichments;
DROP POLICY IF EXISTS "Users can manage own enrichments" ON enrichments;

CREATE POLICY "Users can view own enrichments"
ON enrichments FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can manage own enrichments"
ON enrichments FOR ALL
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

-- ── conversations ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view own conversations" ON conversations;
DROP POLICY IF EXISTS "Users can manage own conversations" ON conversations;

CREATE POLICY "Users can view own conversations"
ON conversations FOR SELECT
TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can manage own conversations"
ON conversations FOR ALL
TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

-- Note: user_profiles policies remain unchanged (already use auth.uid() = id)
