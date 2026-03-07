-- Enable Row Level Security on all tables
-- This ensures users can only access their own data

-- Enable RLS on bucket_configs
ALTER TABLE bucket_configs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own bucket configs
CREATE POLICY "Users can view own bucket configs"
ON bucket_configs FOR SELECT
USING (
  auth.uid() = user_id OR
  (user_id IS NULL AND phone_number = auth.jwt()->>'phone')
);

-- Policy: Users can insert their own bucket configs
CREATE POLICY "Users can insert own bucket configs"
ON bucket_configs FOR INSERT
WITH CHECK (
  auth.uid() = user_id OR
  (user_id IS NULL AND phone_number = auth.jwt()->>'phone')
);

-- Policy: Users can update their own bucket configs
CREATE POLICY "Users can update own bucket configs"
ON bucket_configs FOR UPDATE
USING (
  auth.uid() = user_id OR
  (user_id IS NULL AND phone_number = auth.jwt()->>'phone')
);

-- Policy: Users can delete their own bucket configs
CREATE POLICY "Users can delete own bucket configs"
ON bucket_configs FOR DELETE
USING (
  auth.uid() = user_id OR
  (user_id IS NULL AND phone_number = auth.jwt()->>'phone')
);

-- Enable RLS on events
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own events
CREATE POLICY "Users can view own events"
ON events FOR SELECT
USING (auth.uid() = user_id);

-- Policy: Users can insert their own events
CREATE POLICY "Users can insert own events"
ON events FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Enable RLS on watched_keys
ALTER TABLE watched_keys ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own watched keys
CREATE POLICY "Users can view own watched keys"
ON watched_keys FOR SELECT
USING (auth.uid() = user_id);

-- Policy: Users can manage their own watched keys
CREATE POLICY "Users can manage own watched keys"
ON watched_keys FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Enable RLS on enrichments
ALTER TABLE enrichments ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own enrichments
CREATE POLICY "Users can view own enrichments"
ON enrichments FOR SELECT
USING (auth.uid() = user_id);

-- Policy: Users can manage their own enrichments
CREATE POLICY "Users can manage own enrichments"
ON enrichments FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Enable RLS on conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own conversations
CREATE POLICY "Users can view own conversations"
ON conversations FOR SELECT
USING (auth.uid() = user_id);

-- Policy: Users can manage their own conversations
CREATE POLICY "Users can manage own conversations"
ON conversations FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
