import { pool } from './pool';
import { MIGRATION_SEQUENCE, validateMigrationHistory, type MigrationLedgerEntry } from './migration-history';

const REQUIRED_ENUM_LABELS: Record<string, string[]> = {
  job_status: ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'],
  worker_status: ['idle', 'busy', 'dead', 'revoking'],
  execution_status: ['assigned', 'running', 'completed', 'failed', 'timed_out', 'cancelled'],
  log_level: ['info', 'warn', 'error'],
};

type ColumnSpec = {
  table: string;
  name: string;
  type: string;
  nullable: boolean;
  defaultExpression: string | null;
};

const REQUIRED_COLUMNS: ColumnSpec[] = [
  { table: 'users', name: 'email_verified', type: 'boolean', nullable: false, defaultExpression: 'false' },
  { table: 'email_verification_tokens', name: 'id', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'email_verification_tokens', name: 'user_id', type: 'uuid', nullable: false, defaultExpression: null },
  { table: 'email_verification_tokens', name: 'email', type: 'text', nullable: false, defaultExpression: null },
  { table: 'email_verification_tokens', name: 'token_hash', type: 'text', nullable: false, defaultExpression: null },
  { table: 'email_verification_tokens', name: 'created_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  { table: 'email_verification_tokens', name: 'expires_at', type: 'timestamp with time zone', nullable: false, defaultExpression: null },
  { table: 'email_verification_tokens', name: 'consumed_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'email_verification_tokens', name: 'revoked_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'email_verification_requests', name: 'id', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'email_verification_requests', name: 'email_ciphertext', type: 'bytea', nullable: true, defaultExpression: null },
  { table: 'email_verification_requests', name: 'nonce', type: 'bytea', nullable: true, defaultExpression: null },
  { table: 'email_verification_requests', name: 'auth_tag', type: 'bytea', nullable: true, defaultExpression: null },
  { table: 'email_verification_requests', name: 'state', type: 'text', nullable: false, defaultExpression: "'pending'::text" },
  { table: 'email_verification_requests', name: 'created_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'clock_timestamp()' },
  { table: 'email_verification_requests', name: 'processed_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'id', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'email_verification_deliveries', name: 'verification_token_id', type: 'uuid', nullable: false, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'ciphertext', type: 'bytea', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'nonce', type: 'bytea', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'auth_tag', type: 'bytea', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'state', type: 'text', nullable: false, defaultExpression: "'pending'::text" },
  { table: 'email_verification_deliveries', name: 'attempt_count', type: 'smallint', nullable: false, defaultExpression: '0' },
  { table: 'email_verification_deliveries', name: 'available_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'clock_timestamp()' },
  { table: 'email_verification_deliveries', name: 'lease_id', type: 'uuid', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'lease_expires_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'delivered_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'terminal_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'last_failure_kind', type: 'text', nullable: true, defaultExpression: null },
  { table: 'email_verification_deliveries', name: 'created_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'clock_timestamp()' },
  { table: 'email_verification_rate_limits', name: 'key_hash', type: 'text', nullable: false, defaultExpression: null },
  { table: 'email_verification_rate_limits', name: 'window_started_at', type: 'timestamp with time zone', nullable: false, defaultExpression: null },
  { table: 'email_verification_rate_limits', name: 'request_count', type: 'integer', nullable: false, defaultExpression: null },
  { table: 'email_verification_rate_limits', name: 'expires_at', type: 'timestamp with time zone', nullable: false, defaultExpression: null },
  { table: 'background_jobs', name: 'id', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'background_jobs', name: 'name', type: 'character varying(255)', nullable: false, defaultExpression: null },
  { table: 'background_jobs', name: 'payload', type: 'jsonb', nullable: false, defaultExpression: "'{}'::jsonb" },
  { table: 'background_jobs', name: 'status', type: 'job_status', nullable: false, defaultExpression: "'pending'::job_status" },
  { table: 'background_jobs', name: 'priority', type: 'smallint', nullable: false, defaultExpression: '5' },
  { table: 'background_jobs', name: 'max_retries', type: 'smallint', nullable: false, defaultExpression: '3' },
  { table: 'background_jobs', name: 'retry_count', type: 'smallint', nullable: false, defaultExpression: '0' },
  { table: 'background_jobs', name: 'scheduled_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'background_jobs', name: 'created_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  { table: 'workers', name: 'id', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'workers', name: 'hostname', type: 'character varying(255)', nullable: false, defaultExpression: null },
  { table: 'workers', name: 'status', type: 'worker_status', nullable: false, defaultExpression: "'idle'::worker_status" },
  { table: 'workers', name: 'last_heartbeat', type: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  { table: 'workers', name: 'registered_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  { table: 'workers', name: 'credential_hash', type: 'text', nullable: true, defaultExpression: null },
  { table: 'job_executions', name: 'id', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'job_executions', name: 'job_id', type: 'uuid', nullable: false, defaultExpression: null },
  { table: 'job_executions', name: 'worker_id', type: 'uuid', nullable: false, defaultExpression: null },
  { table: 'job_executions', name: 'attempt', type: 'smallint', nullable: false, defaultExpression: '1' },
  { table: 'job_executions', name: 'status', type: 'execution_status', nullable: false, defaultExpression: "'assigned'::execution_status" },
  { table: 'job_executions', name: 'started_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  { table: 'job_executions', name: 'finished_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'job_executions', name: 'error_message', type: 'text', nullable: true, defaultExpression: null },
  { table: 'job_executions', name: 'lease_token', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'job_executions', name: 'lease_expires_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
  { table: 'job_executions', name: 'revocation_acknowledged_at', type: 'timestamp with time zone', nullable: true, defaultExpression: null },
  { table: 'execution_logs', name: 'id', type: 'uuid', nullable: false, defaultExpression: 'gen_random_uuid()' },
  { table: 'execution_logs', name: 'job_id', type: 'uuid', nullable: false, defaultExpression: null },
  { table: 'execution_logs', name: 'worker_id', type: 'uuid', nullable: true, defaultExpression: null },
  { table: 'execution_logs', name: 'level', type: 'log_level', nullable: false, defaultExpression: "'info'::log_level" },
  { table: 'execution_logs', name: 'message', type: 'text', nullable: false, defaultExpression: null },
  { table: 'execution_logs', name: 'created_at', type: 'timestamp with time zone', nullable: false, defaultExpression: 'now()' },
];

type IndexSpec = {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  predicate: string | null;
};

type ConstraintSpec = {
  name: string;
  table: string;
  type: 'c' | 'f' | 'p' | 'u';
  definition?: string;
  columns?: string[];
  referencedTable?: string;
  referencedColumns?: string[];
  deleteAction?: 'a' | 'r' | 'c' | 'n' | 'd';
};

const ACTIVE_EXECUTIONS = "status = ANY (ARRAY['assigned'::execution_status, 'running'::execution_status])";

const REQUIRED_INDEXES: IndexSpec[] = [
  { name: 'uq_email_verification_tokens_hash', table: 'email_verification_tokens', columns: ['token_hash'], unique: true, predicate: null },
  {
    name: 'uq_email_verification_tokens_outstanding_user_email',
    table: 'email_verification_tokens',
    columns: ['user_id', 'email'],
    unique: true,
    predicate: 'consumed_at IS NULL AND revoked_at IS NULL',
  },
  { name: 'idx_email_verification_requests_pending', table: 'email_verification_requests', columns: ['created_at', 'id'], unique: false, predicate: "state = 'pending'::text" },
  { name: 'idx_email_verification_requests_terminal', table: 'email_verification_requests', columns: ['processed_at', 'id'], unique: false, predicate: "state <> 'pending'::text" },
  { name: 'idx_email_verification_deliveries_pending', table: 'email_verification_deliveries', columns: ['available_at', 'created_at', 'id'], unique: false, predicate: "state = 'pending'::text" },
  { name: 'idx_email_verification_deliveries_expired_lease', table: 'email_verification_deliveries', columns: ['lease_expires_at', 'created_at', 'id'], unique: false, predicate: "state = 'leased'::text" },
  { name: 'idx_email_verification_deliveries_terminal', table: 'email_verification_deliveries', columns: ['terminal_at', 'id'], unique: false, predicate: "state = ANY (ARRAY['delivered'::text, 'failed'::text, 'cancelled'::text])" },
  { name: 'idx_email_verification_rate_limits_expiry', table: 'email_verification_rate_limits', columns: ['expires_at'], unique: false, predicate: null },
  { name: 'idx_job_executions_lease_token', table: 'job_executions', columns: ['lease_token'], unique: true, predicate: null },
  { name: 'idx_job_executions_one_active_per_job', table: 'job_executions', columns: ['job_id'], unique: true, predicate: ACTIVE_EXECUTIONS },
  { name: 'idx_job_executions_one_active_per_worker', table: 'job_executions', columns: ['worker_id'], unique: true, predicate: ACTIVE_EXECUTIONS },
  { name: 'idx_job_executions_expired_active', table: 'job_executions', columns: ['lease_expires_at'], unique: false, predicate: ACTIVE_EXECUTIONS },
  {
    name: 'idx_job_executions_unacknowledged_revocations',
    table: 'job_executions',
    columns: ['worker_id', 'id'],
    unique: false,
    predicate: "(status = ANY (ARRAY['cancelled'::execution_status, 'timed_out'::execution_status])) AND (revocation_acknowledged_at IS NULL)",
  },
];

export const REQUIRED_CONSTRAINTS: ConstraintSpec[] = [
  { name: 'email_verification_tokens_pkey', table: 'email_verification_tokens', type: 'p', columns: ['id'] },
  { name: 'email_verification_tokens_user_fk', table: 'email_verification_tokens', type: 'f', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'], deleteAction: 'c' },
  { name: 'email_verification_tokens_email_normalized_check', table: 'email_verification_tokens', type: 'c', definition: 'CHECK (email = lower(email) AND email = btrim(email))' },
  { name: 'email_verification_tokens_hash_format_check', table: 'email_verification_tokens', type: 'c', definition: "CHECK (token_hash ~ '^[0-9a-f]{64}$'::text)" },
  { name: 'email_verification_tokens_expiry_check', table: 'email_verification_tokens', type: 'c', definition: 'CHECK (expires_at > created_at)' },
  { name: 'email_verification_tokens_terminal_state_check', table: 'email_verification_tokens', type: 'c', definition: 'CHECK (consumed_at IS NULL OR revoked_at IS NULL)' },
  { name: 'email_verification_requests_pkey', table: 'email_verification_requests', type: 'p', columns: ['id'] },
  { name: 'email_verification_requests_state_check', table: 'email_verification_requests', type: 'c', definition: "CHECK (state = ANY (ARRAY['pending'::text, 'processed'::text, 'not_needed'::text, 'failed'::text]))" },
  { name: 'email_verification_requests_payload_check', table: 'email_verification_requests', type: 'c', definition: "CHECK (state = 'pending'::text AND email_ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16 OR (state = ANY (ARRAY['processed'::text, 'not_needed'::text, 'failed'::text])) AND email_ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)" },
  { name: 'email_verification_requests_terminal_check', table: 'email_verification_requests', type: 'c', definition: "CHECK ((state = 'pending'::text) = (processed_at IS NULL))" },
  { name: 'email_verification_deliveries_pkey', table: 'email_verification_deliveries', type: 'p', columns: ['id'] },
  { name: 'email_verification_deliveries_verification_token_id_fkey', table: 'email_verification_deliveries', type: 'f', columns: ['verification_token_id'], referencedTable: 'email_verification_tokens', referencedColumns: ['id'], deleteAction: 'c' },
  { name: 'email_verification_deliveries_verification_token_id_key', table: 'email_verification_deliveries', type: 'u', columns: ['verification_token_id'] },
  { name: 'email_verification_deliveries_state_check', table: 'email_verification_deliveries', type: 'c', definition: "CHECK (state = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text]))" },
  { name: 'email_verification_deliveries_attempts_check', table: 'email_verification_deliveries', type: 'c', definition: 'CHECK (attempt_count >= 0 AND attempt_count <= 5)' },
  { name: 'email_verification_deliveries_cipher_check', table: 'email_verification_deliveries', type: 'c', definition: "CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text])) AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16 OR (state = ANY (ARRAY['delivered'::text, 'failed'::text, 'cancelled'::text])) AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)" },
  { name: 'email_verification_deliveries_lease_check', table: 'email_verification_deliveries', type: 'c', definition: "CHECK ((state = 'leased'::text) = (lease_id IS NOT NULL))" },
  { name: 'email_verification_deliveries_lease_fields_check', table: 'email_verification_deliveries', type: 'c', definition: 'CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))' },
  { name: 'email_verification_deliveries_terminal_check', table: 'email_verification_deliveries', type: 'c', definition: "CHECK ((state = ANY (ARRAY['delivered'::text, 'failed'::text, 'cancelled'::text])) = (terminal_at IS NOT NULL))" },
  { name: 'email_verification_deliveries_delivery_time_check', table: 'email_verification_deliveries', type: 'c', definition: "CHECK ((state = 'delivered'::text) = (delivered_at IS NOT NULL))" },
  { name: 'email_verification_deliveries_failure_check', table: 'email_verification_deliveries', type: 'c', definition: "CHECK (last_failure_kind IS NULL OR (last_failure_kind = ANY (ARRAY['provider'::text, 'network'::text])))" },
  { name: 'email_verification_rate_limits_pkey', table: 'email_verification_rate_limits', type: 'p', columns: ['key_hash'] },
  { name: 'email_verification_rate_limits_hash_check', table: 'email_verification_rate_limits', type: 'c', definition: "CHECK (key_hash ~ '^[0-9a-f]{64}$'::text)" },
  { name: 'email_verification_rate_limits_count_check', table: 'email_verification_rate_limits', type: 'c', definition: 'CHECK (request_count > 0)' },
  { name: 'email_verification_rate_limits_expiry_check', table: 'email_verification_rate_limits', type: 'c', definition: 'CHECK (expires_at > window_started_at)' },
];

function normalizeCatalogExpression(expression: string | null): string | null {
  if (expression === null) return null;
  let normalized = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    const next = expression[index + 1];
    if (singleQuoted) {
      normalized += character;
      if (character === "'" && next === "'") {
        normalized += next;
        index++;
      } else if (character === "'") {
        singleQuoted = false;
      }
    } else if (doubleQuoted) {
      normalized += character;
      if (character === '"' && next === '"') {
        normalized += next;
        index++;
      } else if (character === '"') {
        doubleQuoted = false;
      }
    } else if (character === "'") {
      singleQuoted = true;
      normalized += character;
    } else if (character === '"') {
      doubleQuoted = true;
      normalized += character;
    } else if (!/\s/.test(character) && character !== '(' && character !== ')') {
      normalized += character.toLowerCase();
    }
  }
  return normalized;
}

export async function verifyDatabaseReadiness(): Promise<void> {
  try {
    const { rows: migrations } = await pool.query<MigrationLedgerEntry>(
      'SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at ASC',
    );
    validateMigrationHistory(migrations, true);

    const { rows: enums } = await pool.query<{ type_name: string; label: string }>(
      `SELECT t.typname AS type_name, e.enumlabel AS label
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typname = ANY($1::text[])
         AND t.typnamespace = current_schema()::regnamespace`,
      [Object.keys(REQUIRED_ENUM_LABELS)],
    );
    const enumLabels = new Map<string, Set<string>>();
    for (const { type_name, label } of enums) {
      const labels = enumLabels.get(type_name) ?? new Set<string>();
      labels.add(label);
      enumLabels.set(type_name, labels);
    }
    const missingLabels = Object.entries(REQUIRED_ENUM_LABELS).flatMap(([type, labels]) =>
      labels.filter((label) => !enumLabels.get(type)?.has(label)).map((label) => `${type}.${label}`));
    if (missingLabels.length) {
      throw new Error(`missing enum labels: ${missingLabels.join(', ')}`);
    }

    const tableNames = [...new Set(REQUIRED_COLUMNS.map(({ table }) => table))];
    const { rows: columns } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: boolean;
      default_expression: string | null;
    }>(
      `SELECT table_class.relname AS table_name,
              attribute.attname AS column_name,
              format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
              NOT attribute.attnotnull AS is_nullable,
              pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_expression
       FROM pg_attribute attribute
       JOIN pg_class table_class ON table_class.oid = attribute.attrelid
       JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
       LEFT JOIN pg_attrdef attribute_default
         ON attribute_default.adrelid = attribute.attrelid
        AND attribute_default.adnum = attribute.attnum
       WHERE namespace.nspname = current_schema()
         AND table_class.relname = ANY($1::text[])
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped`,
      [tableNames],
    );
    const columnsByName = new Map(columns.map((column) => [`${column.table_name}.${column.column_name}`, column]));
    const missingColumns = REQUIRED_COLUMNS
      .filter(({ table, name }) => !columnsByName.has(`${table}.${name}`))
      .map(({ table, name }) => `${table}.${name}`);
    if (missingColumns.length) {
      throw new Error(`missing columns: ${missingColumns.join(', ')}`);
    }
    const malformedColumns = REQUIRED_COLUMNS.flatMap((spec) => {
      const column = columnsByName.get(`${spec.table}.${spec.name}`);
      if (!column) return [];
      const typeMatches = column.data_type === spec.type;
      const nullabilityMatches = column.is_nullable === spec.nullable;
      const defaultMatches = normalizeCatalogExpression(column.default_expression)
        === normalizeCatalogExpression(spec.defaultExpression);
      return typeMatches && nullabilityMatches && defaultMatches
        ? []
        : [`${spec.table}.${spec.name} (expected ${spec.type}, ${spec.nullable ? 'nullable' : 'not null'}, default ${spec.defaultExpression ?? 'none'})`];
    });
    if (malformedColumns.length) {
      throw new Error(`columns have incorrect type, nullability, or default: ${malformedColumns.join(', ')}`);
    }

    const indexNames = REQUIRED_INDEXES.map(({ name }) => name);
    const { rows: indexes } = await pool.query<{
      index_name: string;
      table_name: string;
      access_method: string;
      indexed_columns: Array<string | null>;
      is_unique: boolean;
      is_partial: boolean;
      is_valid: boolean;
      is_ready: boolean;
      predicate: string | null;
    }>(
      `SELECT index_class.relname AS index_name,
              table_class.relname AS table_name,
              access_method.amname AS access_method,
              ARRAY(
                SELECT indexed_attribute.attname::text
                FROM unnest(index_info.indkey) WITH ORDINALITY AS index_key(attnum, ordinal)
                LEFT JOIN pg_attribute indexed_attribute
                  ON indexed_attribute.attrelid = index_info.indrelid
                 AND indexed_attribute.attnum = index_key.attnum
                WHERE index_key.ordinal <= index_info.indnatts
                ORDER BY index_key.ordinal
              ) AS indexed_columns,
              index_info.indisunique AS is_unique,
              index_info.indpred IS NOT NULL AS is_partial,
              index_info.indisvalid AS is_valid,
              index_info.indisready AS is_ready,
              pg_get_expr(index_info.indpred, index_info.indrelid) AS predicate
       FROM pg_index index_info
       JOIN pg_class table_class ON table_class.oid = index_info.indrelid
       JOIN pg_class index_class ON index_class.oid = index_info.indexrelid
       JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
       JOIN pg_am access_method ON access_method.oid = index_class.relam
       WHERE namespace.nspname = current_schema()
         AND index_class.relname = ANY($1::text[])`,
      [indexNames],
    );
    const indexByName = new Map(indexes.map((index) => [index.index_name, index]));
    const missingIndexes = REQUIRED_INDEXES.filter(({ name }) => !indexByName.has(name)).map(({ name }) => name);
    if (missingIndexes.length) {
      throw new Error(`missing indexes: ${missingIndexes.join(', ')}`);
    }
    const malformedIndexes = REQUIRED_INDEXES.flatMap((spec) => {
      const index = indexByName.get(spec.name);
      if (!index) return [];
      const expectedPredicate = normalizeCatalogExpression(spec.predicate);
      const actualPredicate = normalizeCatalogExpression(index.predicate);
      const valid = index.table_name === spec.table
        && index.access_method === 'btree'
        && JSON.stringify(index.indexed_columns) === JSON.stringify(spec.columns)
        && index.is_unique === spec.unique
        && index.is_partial === (spec.predicate !== null)
        && index.is_valid
        && index.is_ready
        && actualPredicate === expectedPredicate;
      return valid ? [] : [spec.name];
    });
    if (malformedIndexes.length) {
      throw new Error(`indexes have incorrect table, columns, uniqueness, validity, readiness, or predicate: ${malformedIndexes.join(', ')}`);
    }

    const constraintNames = REQUIRED_CONSTRAINTS.map(({ name }) => name);
    const { rows: constraints } = await pool.query<{
      constraint_name: string;
      table_name: string;
      constraint_type: 'c' | 'f' | 'p' | 'u';
      definition: string;
      columns: Array<string | null>;
      referenced_table: string | null;
      referenced_columns: Array<string | null>;
      delete_action: 'a' | 'r' | 'c' | 'n' | 'd' | null;
      is_valid: boolean;
      is_deferrable: boolean;
      initially_deferred: boolean;
    }>(
      `SELECT constraint_class.conname AS constraint_name,
              table_class.relname AS table_name,
              constraint_class.contype AS constraint_type,
              pg_get_constraintdef(constraint_class.oid, true) AS definition,
              ARRAY(
                SELECT attribute.attname::text
                FROM unnest(constraint_class.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_class.conrelid
                 AND attribute.attnum = key_column.attnum
                ORDER BY key_column.ordinal
              ) AS columns,
              referenced_table.relname AS referenced_table,
              ARRAY(
                SELECT attribute.attname::text
                FROM unnest(constraint_class.confkey) WITH ORDINALITY AS key_column(attnum, ordinal)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_class.confrelid
                 AND attribute.attnum = key_column.attnum
                ORDER BY key_column.ordinal
              ) AS referenced_columns,
              constraint_class.confdeltype AS delete_action,
              constraint_class.convalidated AS is_valid,
              constraint_class.condeferrable AS is_deferrable,
              constraint_class.condeferred AS initially_deferred
       FROM pg_constraint constraint_class
       JOIN pg_class table_class ON table_class.oid = constraint_class.conrelid
       JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
       LEFT JOIN pg_class referenced_table ON referenced_table.oid = constraint_class.confrelid
       WHERE namespace.nspname = current_schema()
         AND constraint_class.conname = ANY($1::text[])`,
      [constraintNames],
    );
    const constraintByName = new Map(constraints.map((constraint) => [constraint.constraint_name, constraint]));
    const missingConstraints = REQUIRED_CONSTRAINTS
      .filter(({ name }) => !constraintByName.has(name))
      .map(({ name }) => name);
    if (missingConstraints.length) {
      throw new Error(`missing constraints: ${missingConstraints.join(', ')}`);
    }
    const malformedConstraints = REQUIRED_CONSTRAINTS.flatMap((spec) => {
      const constraint = constraintByName.get(spec.name);
      if (!constraint) return [];
      const valid = constraint.table_name === spec.table
        && constraint.constraint_type === spec.type
        && constraint.is_valid
        && !constraint.is_deferrable
        && !constraint.initially_deferred
        && (spec.definition === undefined
          || normalizeCatalogExpression(constraint.definition) === normalizeCatalogExpression(spec.definition))
        && (spec.columns === undefined || JSON.stringify(constraint.columns) === JSON.stringify(spec.columns))
        && (spec.referencedTable === undefined || constraint.referenced_table === spec.referencedTable)
        && (spec.referencedColumns === undefined || JSON.stringify(constraint.referenced_columns) === JSON.stringify(spec.referencedColumns))
        && (spec.deleteAction === undefined || constraint.delete_action === spec.deleteAction);
      return valid ? [] : [spec.name];
    });
    if (malformedConstraints.length) {
      throw new Error(`constraints have incorrect table, type, definition, columns, reference, delete action, or validation state: ${malformedConstraints.join(', ')}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown database readiness error';
    throw new Error(`Database schema is not ready. Apply the required migrations with the migration runner, then restart the API. ${detail}`);
  }
}
