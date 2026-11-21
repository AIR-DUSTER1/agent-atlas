-- 002_multitenant.sql — 用户体系语义迁移（tenant/owner → user）与登录列
-- 用户体系改造（U0/U1）：隔离单位从"租户"统一为"用户"。
--  - 7 张用户私有数据表的 owner_id 列改名 user_id（索引、RLS 策略跟随重建）；
--  - RLS 会话变量 app.owner_id → app.user_id（与运行时 withUserTransaction 的
--    SET LOCAL 一致，两边必须同步改，任何一边漏改都会导致 RLS 全表拒绝）；
--  - users 表增补登录列（username / password_hash / must_change_password / last_login_at）。
-- 幂等：所有动作先探测再执行；已升级的库重复执行不产生任何变化。
-- 注意：auth_tokens / devices 两表自 001 起就叫 user_id，无需改名。

-- ---------------------------------------------------------------------------
-- 1. 列改名 owner_id → user_id（7 张私有表）
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'session_journal_events', 'projects', 'user_settings', 'memories',
    'checkpoint_rows', 'checkpoint_writes', 'audit_events'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = t AND column_name = 'owner_id'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = t AND column_name = 'user_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN owner_id TO user_id', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. 索引重建（001 的索引名带 owner 前缀；改名后按新列重建并清掉旧名）
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS session_journal_events_owner_seq_idx;
CREATE INDEX IF NOT EXISTS session_journal_events_user_seq_idx
  ON session_journal_events(user_id, seq);

DROP INDEX IF EXISTS projects_owner_updated_idx;
CREATE INDEX IF NOT EXISTS projects_user_updated_idx
  ON projects(user_id, updated_at DESC);

DROP INDEX IF EXISTS memories_owner_profile_status_idx;
CREATE INDEX IF NOT EXISTS memories_user_profile_status_idx
  ON memories(user_id, profile_id, status, updated_at DESC);

DROP INDEX IF EXISTS checkpoint_rows_owner_thread_idx;
CREATE INDEX IF NOT EXISTS checkpoint_rows_user_thread_idx
  ON checkpoint_rows(user_id, thread_id, created_at DESC);

DROP INDEX IF EXISTS checkpoint_writes_owner_thread_idx;
CREATE INDEX IF NOT EXISTS checkpoint_writes_user_thread_idx
  ON checkpoint_writes(user_id, thread_id, created_at DESC);

DROP INDEX IF EXISTS audit_events_owner_created_idx;
CREATE INDEX IF NOT EXISTS audit_events_user_created_idx
  ON audit_events(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. RLS 策略重建（旧策略引用 owner_id 列与 app.owner_id 变量，必须整体重建）
-- ---------------------------------------------------------------------------

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_settings_owner ON user_settings;
CREATE POLICY user_settings_owner ON user_settings
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE session_journal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_journal_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_journal_events_owner ON session_journal_events;
CREATE POLICY session_journal_events_owner ON session_journal_events
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_owner ON projects;
CREATE POLICY projects_owner ON projects
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memories_owner ON memories;
CREATE POLICY memories_owner ON memories
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE checkpoint_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkpoint_rows_owner ON checkpoint_rows;
CREATE POLICY checkpoint_rows_owner ON checkpoint_rows
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE checkpoint_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_writes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkpoint_writes_owner ON checkpoint_writes;
CREATE POLICY checkpoint_writes_owner ON checkpoint_writes
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_events_owner ON audit_events;
CREATE POLICY audit_events_owner ON audit_events
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid OR user_id IS NULL)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid OR user_id IS NULL);

-- ---------------------------------------------------------------------------
-- 4. users 表登录列（U1 用户名密码登录）
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
-- 凭据纪元：改密后自增；会话载荷 epo 与设备 Cookie iat 低于该时间戳的凭据一律要求重登。
ALTER TABLE users ADD COLUMN IF NOT EXISTS credential_epoch timestamptz;

-- 登录名唯一（大小写不敏感）；username 为空 = 该用户仅令牌可入。
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON users (lower(username)) WHERE username IS NOT NULL;
