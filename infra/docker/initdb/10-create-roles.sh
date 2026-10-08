#!/usr/bin/env bash
#
# Create the three application database roles from ADR-0003 (D2):
#
#   hmn_migrator  — owns tables, runs Prisma migrations (CLI only)
#   hmn_app       — runtime role for API/worker; non-owner, RLS always enforced
#   hmn_platform  — audited platform operations; non-owner, RLS always enforced
#
# Runs automatically on first volume initialisation via docker-entrypoint-initdb.d.
# It is idempotent, so it can also be applied to an existing cluster:
#
#   docker exec -e HMN_MIGRATOR_PASSWORD=... -e HMN_APP_PASSWORD=... \
#     -e HMN_PLATFORM_PASSWORD=... -e POSTGRES_USER=... -e POSTGRES_DB=... \
#     hmn-postgres bash -s < infra/docker/initdb/10-create-roles.sh
#
# Passwords come from infra/docker/.env (git-ignored) and are passed through the
# container environment; they are never written to disk here.
#
# NOTE: table-level grants (SELECT on global tables, DML on tenant tables) are NOT
# created here. They live in the schema migrations (packages/db/prisma/migrations),
# so role permissions stay versioned with the schema that needs them — per ADR-0003 D7.

set -euo pipefail

: "${HMN_MIGRATOR_PASSWORD:?HMN_MIGRATOR_PASSWORD is required (infra/docker/.env)}"
: "${HMN_APP_PASSWORD:?HMN_APP_PASSWORD is required (infra/docker/.env)}"
: "${HMN_PLATFORM_PASSWORD:?HMN_PLATFORM_PASSWORD is required (infra/docker/.env)}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

psql=(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB")

role_exists() {
  "${psql[@]}" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$1'" | grep -q 1
}

create_role_if_absent() {
  local role="$1" password="$2"
  if role_exists "$role"; then
    echo "role $role already exists — leaving credentials untouched"
  else
    # Passwords are locally generated hex strings; simple quoting is safe.
    "${psql[@]}" -c "CREATE ROLE $role LOGIN PASSWORD '$password'"
    echo "created role $role"
  fi
}

# -- postgres = cluster superuser (POSTGRES_USER) --
create_role_if_absent hmn_migrator "$HMN_MIGRATOR_PASSWORD"
create_role_if_absent hmn_app "$HMN_APP_PASSWORD"
create_role_if_absent hmn_platform "$HMN_PLATFORM_PASSWORD"

# Database- and schema-level privileges. None of these roles is a superuser and
# none carries BYPASSRLS: hmn_app and hmn_platform are non-owners and therefore
# unconditionally subject to every RLS policy (ADR-0003 D2/D5).
"${psql[@]}" <<SQL
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO hmn_migrator, hmn_app, hmn_platform;
-- The migrator must be able to create/alter tables (and the _prisma_migrations
-- bookkeeping table) and to run migrations that create schemas; it is still NOT
-- a superuser and has no BYPASSRLS.
GRANT CREATE, TEMPORARY ON DATABASE "$POSTGRES_DB" TO hmn_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO hmn_migrator;
-- Runtime roles execute DML only; CREATE on the schema is deliberately withheld.
GRANT USAGE ON SCHEMA public TO hmn_app, hmn_platform;
SQL

echo "ADR-0003 roles provisioned"
