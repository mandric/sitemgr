-- Migrate all tables to use user_id as primary tenant identifier
-- Phone number becomes an optional profile attribute

-- Create user profiles table to store phone numbers
CREATE TABLE user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    phone_number TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS on user_profiles
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
ON user_profiles FOR SELECT
USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
ON user_profiles FOR UPDATE
USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
ON user_profiles FOR INSERT
WITH CHECK (auth.uid() = id);

-- Add user_id to events table
ALTER TABLE events ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX idx_events_user_id ON events(user_id);

-- Add user_id to watched_keys table
ALTER TABLE watched_keys ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX idx_watched_keys_user_id ON watched_keys(user_id);

-- Add user_id to enrichments table
ALTER TABLE enrichments ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX idx_enrichments_user_id ON enrichments(user_id);

-- Add user_id to conversations table
ALTER TABLE conversations ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX idx_conversations_user_id ON conversations(user_id);

-- Helper function to get user_id from phone number
CREATE OR REPLACE FUNCTION get_user_id_from_phone(p_phone_number TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT id INTO v_user_id
    FROM user_profiles
    WHERE phone_number = p_phone_number;

    RETURN v_user_id;
END;
$$;

-- Note: We keep phone_number columns for now for backward compatibility
-- In a future migration, we can migrate existing data and drop phone_number columns
