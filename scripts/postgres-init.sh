#!/bin/sh
# 创建运行时低权限角色，并预授权未来 migration 创建的表/序列。
# 固定角色名 agent_app 与 docker-compose.postgres.yml 的 DATABASE_URL 一致。
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" \
  --set=db_name="$POSTGRES_DB" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_app') THEN
    CREATE ROLE agent_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE agent_app WITH PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db_name" TO agent_app;
GRANT USAGE ON SCHEMA public TO agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agent_app;
EOSQL