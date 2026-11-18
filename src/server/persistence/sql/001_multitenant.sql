-- 001_multitenant.sql — PostgreSQL 多租户基础表与 RLS
-- 所有用户私有表必须带 owner_id，运行时通过事务级 app.owner_id 校验。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  email text,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id);

-- 会话 journal 采用 append-only 事件流；owner_id 是唯一的租户键。
CREATE TABLE IF NOT EXISTS session_journal_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_journal_events_owner_seq_idx
  ON session_journal_events(owner_id, seq);

CREATE TABLE IF NOT EXISTS projects (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('local', 'cloud')),
  path text NOT NULL,
  url text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_settings_owner ON user_settings;
CREATE POLICY user_settings_owner ON user_settings
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS projects_owner_updated_idx
  ON projects(owner_id, updated_at DESC);

-- 长期记忆先保留完整领域载荷；迁移到 pgvector 时可从 payload 建立投影表。
CREATE TABLE IF NOT EXISTS memories (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (owner_id, profile_id, id)
);

CREATE INDEX IF NOT EXISTS memories_owner_profile_status_idx
  ON memories(owner_id, profile_id, status, updated_at DESC);

-- LangGraph checkpoint 的持久化行；owner_id 防止跨租户 thread_id 读取。
CREATE TABLE IF NOT EXISTS checkpoint_rows (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  parent_id text,
  checkpoint_type text NOT NULL,
  checkpoint_data bytea NOT NULL,
  metadata_type text NOT NULL,
  metadata_data bytea NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (owner_id, thread_id, checkpoint_ns, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS checkpoint_rows_owner_thread_idx
  ON checkpoint_rows(owner_id, thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS checkpoint_writes (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  task_id text NOT NULL,
  idx integer NOT NULL,
  channel text NOT NULL,
  value_type text NOT NULL,
  value_data bytea NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (owner_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

CREATE INDEX IF NOT EXISTS checkpoint_writes_owner_thread_idx
  ON checkpoint_writes(owner_id, thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_owner_created_idx
  ON audit_events(owner_id, created_at DESC);

ALTER TABLE session_journal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_journal_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_journal_events_owner ON session_journal_events;
CREATE POLICY session_journal_events_owner ON session_journal_events
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_owner ON projects;
CREATE POLICY projects_owner ON projects
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memories_owner ON memories;
CREATE POLICY memories_owner ON memories
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid);

ALTER TABLE checkpoint_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkpoint_rows_owner ON checkpoint_rows;
CREATE POLICY checkpoint_rows_owner ON checkpoint_rows
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid);

ALTER TABLE checkpoint_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_writes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkpoint_writes_owner ON checkpoint_writes;
CREATE POLICY checkpoint_writes_owner ON checkpoint_writes
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_events_owner ON audit_events;
CREATE POLICY audit_events_owner ON audit_events
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid OR owner_id IS NULL)
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid OR owner_id IS NULL);