import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import { REQUIRED_CONSTRAINTS, verifyDatabaseReadiness } from '../db/readiness';
import { startBackgroundServicesWhenReady } from '../startup';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

const migrationNames = [
  '001_initial_schema.sql',
  '002_rename_background_jobs.sql',
  '003_auth.sql',
  '004_execution_leases.sql',
  '005_cancelled_execution_status.sql',
  '006_worker_revocation.sql',
  '007_project_foundation.sql',
  '007a_execution_log_association.sql',
  '007b_email_verification_tokens.sql',
  '007c_email_delivery_and_rate_limits.sql',
];

const enumLabels = [
  ...['pending', 'queued', 'running', 'completed', 'failed', 'cancelled']
    .map((label) => ({ type_name: 'job_status', label })),
  ...['idle', 'busy', 'dead', 'revoking'].map((label) => ({ type_name: 'worker_status', label })),
  ...['assigned', 'running', 'completed', 'failed', 'timed_out', 'cancelled']
    .map((label) => ({ type_name: 'execution_status', label })),
  ...['info', 'warn', 'error'].map((label) => ({ type_name: 'log_level', label })),
];

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  default_expression: string | null;
};

const columns: ColumnRow[] = [
  ['users', 'email_verified', 'boolean', false, 'false'],
  ['email_verification_tokens', 'id', 'uuid', false, 'gen_random_uuid()'],
  ['email_verification_tokens', 'user_id', 'uuid', false, null],
  ['email_verification_tokens', 'email', 'text', false, null],
  ['email_verification_tokens', 'token_hash', 'text', false, null],
  ['email_verification_tokens', 'created_at', 'timestamp with time zone', false, 'now()'],
  ['email_verification_tokens', 'expires_at', 'timestamp with time zone', false, null],
  ['email_verification_tokens', 'consumed_at', 'timestamp with time zone', true, null],
  ['email_verification_tokens', 'revoked_at', 'timestamp with time zone', true, null],
  ['email_verification_requests', 'id', 'uuid', false, 'gen_random_uuid()'],
  ['email_verification_requests', 'email_ciphertext', 'bytea', true, null],
  ['email_verification_requests', 'nonce', 'bytea', true, null],
  ['email_verification_requests', 'auth_tag', 'bytea', true, null],
  ['email_verification_requests', 'state', 'text', false, "'pending'::text"],
  ['email_verification_requests', 'created_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['email_verification_requests', 'processed_at', 'timestamp with time zone', true, null],
  ['email_verification_deliveries', 'id', 'uuid', false, 'gen_random_uuid()'],
  ['email_verification_deliveries', 'verification_token_id', 'uuid', false, null],
  ['email_verification_deliveries', 'ciphertext', 'bytea', true, null],
  ['email_verification_deliveries', 'nonce', 'bytea', true, null],
  ['email_verification_deliveries', 'auth_tag', 'bytea', true, null],
  ['email_verification_deliveries', 'state', 'text', false, "'pending'::text"],
  ['email_verification_deliveries', 'attempt_count', 'smallint', false, '0'],
  ['email_verification_deliveries', 'available_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['email_verification_deliveries', 'lease_id', 'uuid', true, null],
  ['email_verification_deliveries', 'lease_expires_at', 'timestamp with time zone', true, null],
  ['email_verification_deliveries', 'delivered_at', 'timestamp with time zone', true, null],
  ['email_verification_deliveries', 'terminal_at', 'timestamp with time zone', true, null],
  ['email_verification_deliveries', 'last_failure_kind', 'text', true, null],
  ['email_verification_deliveries', 'created_at', 'timestamp with time zone', false, 'clock_timestamp()'],
  ['email_verification_rate_limits', 'key_hash', 'text', false, null],
  ['email_verification_rate_limits', 'window_started_at', 'timestamp with time zone', false, null],
  ['email_verification_rate_limits', 'request_count', 'integer', false, null],
  ['email_verification_rate_limits', 'expires_at', 'timestamp with time zone', false, null],
  ['background_jobs', 'id', 'uuid', false, 'gen_random_uuid()'],
  ['background_jobs', 'name', 'character varying(255)', false, null],
  ['background_jobs', 'payload', 'jsonb', false, "'{}'::jsonb"],
  ['background_jobs', 'status', 'job_status', false, "'pending'::job_status"],
  ['background_jobs', 'priority', 'smallint', false, '5'],
  ['background_jobs', 'max_retries', 'smallint', false, '3'],
  ['background_jobs', 'retry_count', 'smallint', false, '0'],
  ['background_jobs', 'scheduled_at', 'timestamp with time zone', true, null],
  ['background_jobs', 'created_at', 'timestamp with time zone', false, 'now()'],
  ['workers', 'id', 'uuid', false, 'gen_random_uuid()'],
  ['workers', 'hostname', 'character varying(255)', false, null],
  ['workers', 'status', 'worker_status', false, "'idle'::worker_status"],
  ['workers', 'last_heartbeat', 'timestamp with time zone', false, 'now()'],
  ['workers', 'registered_at', 'timestamp with time zone', false, 'now()'],
  ['workers', 'credential_hash', 'text', true, null],
  ['job_executions', 'id', 'uuid', false, 'gen_random_uuid()'],
  ['job_executions', 'job_id', 'uuid', false, null],
  ['job_executions', 'worker_id', 'uuid', false, null],
  ['job_executions', 'attempt', 'smallint', false, '1'],
  ['job_executions', 'status', 'execution_status', false, "'assigned'::execution_status"],
  ['job_executions', 'started_at', 'timestamp with time zone', false, 'now()'],
  ['job_executions', 'finished_at', 'timestamp with time zone', true, null],
  ['job_executions', 'error_message', 'text', true, null],
  ['job_executions', 'lease_token', 'uuid', false, 'gen_random_uuid()'],
  ['job_executions', 'lease_expires_at', 'timestamp with time zone', false, 'now()'],
  ['job_executions', 'revocation_acknowledged_at', 'timestamp with time zone', true, null],
  ['execution_logs', 'id', 'uuid', false, 'gen_random_uuid()'],
  ['execution_logs', 'job_id', 'uuid', false, null],
  ['execution_logs', 'worker_id', 'uuid', true, null],
  ['execution_logs', 'level', 'log_level', false, "'info'::log_level"],
  ['execution_logs', 'message', 'text', false, null],
  ['execution_logs', 'created_at', 'timestamp with time zone', false, 'now()'],
].map(([table_name, column_name, data_type, is_nullable, default_expression]) => ({
  table_name: String(table_name),
  column_name: String(column_name),
  data_type: String(data_type),
  is_nullable: Boolean(is_nullable),
  default_expression: default_expression === null ? null : String(default_expression),
}));

type IndexRow = {
  index_name: string;
  table_name: string;
  access_method: string;
  indexed_columns: Array<string | null>;
  is_unique: boolean;
  is_partial: boolean;
  is_valid: boolean;
  is_ready: boolean;
  predicate: string | null;
};

const activePredicate = "(status = ANY (ARRAY['assigned'::execution_status, 'running'::execution_status]))";
const indexes: IndexRow[] = [
  { index_name: 'uq_email_verification_tokens_hash', table_name: 'email_verification_tokens', access_method: 'btree', indexed_columns: ['token_hash'], is_unique: true, is_partial: false, is_valid: true, is_ready: true, predicate: null },
  { index_name: 'uq_email_verification_tokens_outstanding_user_email', table_name: 'email_verification_tokens', access_method: 'btree', indexed_columns: ['user_id', 'email'], is_unique: true, is_partial: true, is_valid: true, is_ready: true, predicate: '(consumed_at IS NULL AND revoked_at IS NULL)' },
  { index_name: 'idx_email_verification_requests_pending', table_name: 'email_verification_requests', access_method: 'btree', indexed_columns: ['created_at', 'id'], is_unique: false, is_partial: true, is_valid: true, is_ready: true, predicate: "(state = 'pending'::text)" },
  { index_name: 'idx_email_verification_requests_terminal', table_name: 'email_verification_requests', access_method: 'btree', indexed_columns: ['processed_at', 'id'], is_unique: false, is_partial: true, is_valid: true, is_ready: true, predicate: "(state <> 'pending'::text)" },
  { index_name: 'idx_email_verification_deliveries_pending', table_name: 'email_verification_deliveries', access_method: 'btree', indexed_columns: ['available_at', 'created_at', 'id'], is_unique: false, is_partial: true, is_valid: true, is_ready: true, predicate: "(state = 'pending'::text)" },
  { index_name: 'idx_email_verification_deliveries_expired_lease', table_name: 'email_verification_deliveries', access_method: 'btree', indexed_columns: ['lease_expires_at', 'created_at', 'id'], is_unique: false, is_partial: true, is_valid: true, is_ready: true, predicate: "(state = 'leased'::text)" },
  { index_name: 'idx_email_verification_deliveries_terminal', table_name: 'email_verification_deliveries', access_method: 'btree', indexed_columns: ['terminal_at', 'id'], is_unique: false, is_partial: true, is_valid: true, is_ready: true, predicate: "(state = ANY (ARRAY['delivered'::text, 'failed'::text, 'cancelled'::text]))" },
  { index_name: 'idx_email_verification_rate_limits_expiry', table_name: 'email_verification_rate_limits', access_method: 'btree', indexed_columns: ['expires_at'], is_unique: false, is_partial: false, is_valid: true, is_ready: true, predicate: null },
  { index_name: 'idx_job_executions_lease_token', table_name: 'job_executions', access_method: 'btree', indexed_columns: ['lease_token'], is_unique: true, is_partial: false, is_valid: true, is_ready: true, predicate: null },
  { index_name: 'idx_job_executions_one_active_per_job', table_name: 'job_executions', access_method: 'btree', indexed_columns: ['job_id'], is_unique: true, is_partial: true, is_valid: true, is_ready: true, predicate: activePredicate },
  { index_name: 'idx_job_executions_one_active_per_worker', table_name: 'job_executions', access_method: 'btree', indexed_columns: ['worker_id'], is_unique: true, is_partial: true, is_valid: true, is_ready: true, predicate: activePredicate },
  { index_name: 'idx_job_executions_expired_active', table_name: 'job_executions', access_method: 'btree', indexed_columns: ['lease_expires_at'], is_unique: false, is_partial: true, is_valid: true, is_ready: true, predicate: activePredicate },
  {
    index_name: 'idx_job_executions_unacknowledged_revocations',
    table_name: 'job_executions',
    access_method: 'btree',
    indexed_columns: ['worker_id', 'id'],
    is_unique: false,
    is_partial: true,
    is_valid: true,
    is_ready: true,
    predicate: "((status = ANY (ARRAY['cancelled'::execution_status, 'timed_out'::execution_status])) AND (revocation_acknowledged_at IS NULL))",
  },
];

type ReadinessRows = {
  migrations?: Array<{ filename: string; applied_at: Date | string }>;
  enums?: typeof enumLabels;
  columns?: ColumnRow[];
  indexes?: IndexRow[];
  constraints?: Array<{
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
  }>;
};

const constraints = REQUIRED_CONSTRAINTS.map((spec) => ({
  constraint_name: spec.name,
  table_name: spec.table,
  constraint_type: spec.type,
  definition: spec.definition ?? (spec.type === 'f'
    ? `FOREIGN KEY (${spec.columns?.join(', ')}) REFERENCES ${spec.referencedTable}(${spec.referencedColumns?.join(', ')}) ON DELETE CASCADE`
    : `${spec.type === 'p' ? 'PRIMARY KEY' : 'UNIQUE'} (${spec.columns?.join(', ')})`),
  columns: spec.columns ?? [],
  referenced_table: spec.referencedTable ?? null,
  referenced_columns: spec.referencedColumns ?? [],
  delete_action: spec.deleteAction ?? null,
  is_valid: true,
  is_deferrable: false,
  initially_deferred: false,
}));

function mockReadiness(rows: ReadinessRows = {}) {
  vi.mocked(pool.query)
    .mockResolvedValueOnce({ rows: rows.migrations ?? migrationNames.map((filename, index) => ({
      filename,
      applied_at: new Date(Date.UTC(2020, 0, 1, 0, 0, index)),
    })) } as never)
    .mockResolvedValueOnce({ rows: rows.enums ?? enumLabels } as never)
    .mockResolvedValueOnce({ rows: rows.columns ?? columns } as never)
    .mockResolvedValueOnce({ rows: rows.indexes ?? indexes } as never)
    .mockResolvedValueOnce({ rows: rows.constraints ?? constraints } as never);
}

describe('runtime database readiness', () => {
  beforeEach(() => vi.resetAllMocks());

  it('accepts the required migrations and catalog definitions', async () => {
    mockReadiness();
    await expect(verifyDatabaseReadiness()).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(5);
  });

  it.each(migrationNames)('rejects when %s is missing from the migration ledger', async (missing) => {
    mockReadiness({ migrations: migrationNames.filter((filename) => filename !== missing).map((filename, index) => ({
      filename, applied_at: new Date(Date.UTC(2020, 0, 1, 0, 0, index)),
    })) });
    const expectedDiagnostic = migrationNames.indexOf(missing) < migrationNames.length - 1
      ? `missing predecessor migrations before an applied later migration: ${missing}`
      : `missing migrations: ${missing}`;
    await expect(verifyDatabaseReadiness()).rejects.toThrow(expectedDiagnostic);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing email-verification foreign key', async () => {
    mockReadiness({ constraints: constraints.filter(({ constraint_name }) => constraint_name !== 'email_verification_tokens_user_fk') });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('missing constraints: email_verification_tokens_user_fk');
    expect(pool.query).toHaveBeenCalledTimes(5);
  });

  it('rejects a same-name email-verification foreign key with the wrong target or delete action', async () => {
    mockReadiness({ constraints: constraints.map((entry) => entry.constraint_name === 'email_verification_tokens_user_fk'
      ? { ...entry, referenced_table: 'background_jobs', delete_action: 'a' }
      : entry) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('email_verification_tokens_user_fk');
  });

  it('rejects an altered delivery state constraint', async () => {
    mockReadiness({ constraints: constraints.map((entry) => entry.constraint_name === 'email_verification_deliveries_state_check'
      ? { ...entry, definition: 'CHECK (state IS NOT NULL)' }
      : entry) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('email_verification_deliveries_state_check');
  });

  it('rejects an unvalidated required constraint', async () => {
    mockReadiness({ constraints: constraints.map((entry) => entry.constraint_name === 'email_verification_rate_limits_count_check'
      ? { ...entry, is_valid: false }
      : entry) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('email_verification_rate_limits_count_check');
  });

  it('rejects unknown migration entries', async () => {
    mockReadiness({ migrations: [
      ...migrationNames.map((filename, index) => ({ filename, applied_at: new Date(Date.UTC(2020, 0, 1, 0, 0, index)) })),
      { filename: '008_unrecognized.sql', applied_at: new Date(Date.UTC(2020, 0, 2)) },
    ] });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('unknown migration ledger entries: 008_unrecognized.sql');
  });

  it('rejects duplicate migration ledger rows', async () => {
    const history = migrationNames.map((filename, index) => ({ filename, applied_at: new Date(Date.UTC(2020, 0, 1, 0, 0, index)) }));
    mockReadiness({ migrations: [...history, history[0]] });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('duplicate migration ledger entries');
  });

  it('rejects a fully recorded migration history with timestamps out of order', async () => {
    const history = migrationNames.map((filename, index) => ({ filename, applied_at: new Date(Date.UTC(2020, 0, 1, 0, 0, index)) }));
    const firstTime = history[1].applied_at;
    history[1].applied_at = history[2].applied_at;
    history[2].applied_at = firstTime;
    mockReadiness({ migrations: history });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('out-of-order migration history');
  });

  it('rejects a missing enum label', async () => {
    mockReadiness({ enums: enumLabels.filter(({ label, type_name }) => !(type_name === 'execution_status' && label === 'cancelled')) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('execution_status.cancelled');
  });

  it('rejects a missing critical column', async () => {
    mockReadiness({ columns: columns.filter(({ table_name, column_name }) => !(table_name === 'job_executions' && column_name === 'lease_expires_at')) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('missing columns: job_executions.lease_expires_at');
  });

  it.each([
    ['wrong data type', { data_type: 'text' }],
    ['incorrect nullability', { is_nullable: true }],
    ['incorrect default', { default_expression: null }],
  ])('rejects a lease_expires_at column with %s', async (_case, change) => {
    mockReadiness({ columns: columns.map((column) => column.table_name === 'job_executions' && column.column_name === 'lease_expires_at'
      ? { ...column, ...change } : column) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('job_executions.lease_expires_at');
  });

  it('rejects a lifecycle status column that is not backed by its expected enum', async () => {
    mockReadiness({ columns: columns.map((column) => column.table_name === 'background_jobs' && column.column_name === 'status'
      ? { ...column, data_type: 'text' } : column) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('background_jobs.status');
  });

  it('preserves enum literal case when validating catalog defaults', async () => {
    mockReadiness({ columns: columns.map((column) => column.table_name === 'background_jobs' && column.column_name === 'status'
      ? { ...column, default_expression: "'PENDING'::job_status" } : column) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('background_jobs.status');
  });

  it.each([
    ['wrong owning table', { table_name: 'background_jobs' }],
    ['wrong indexed columns', { indexed_columns: ['job_id'] }],
    ['wrong partial predicate', { predicate: "status = ANY (ARRAY['failed'::execution_status])" }],
    ['non-unique definition', { is_unique: false }],
    ['non-partial definition', { is_partial: false }],
    ['invalid index', { is_valid: false }],
    ['index not ready', { is_ready: false }],
  ])('rejects a same-name index with %s', async (_case, change) => {
    mockReadiness({ indexes: indexes.map((index) => index.index_name === 'idx_job_executions_one_active_per_worker'
      ? { ...index, ...change } : index) });
    await expect(verifyDatabaseReadiness()).rejects.toThrow('idx_job_executions_one_active_per_worker');
  });

  it('does not start background services when readiness fails', async () => {
    const startScheduler = vi.fn();
    const startMonitor = vi.fn();
    await expect(startBackgroundServicesWhenReady(
      async () => { throw new Error('not ready'); }, startScheduler, startMonitor,
    )).rejects.toThrow('not ready');
    expect(startScheduler).not.toHaveBeenCalled();
    expect(startMonitor).not.toHaveBeenCalled();
  });

  it('starts scheduler and monitor only after all readiness checks pass', async () => {
    mockReadiness();
    const order: string[] = [];
    await startBackgroundServicesWhenReady(
      verifyDatabaseReadiness,
      () => order.push('scheduler'),
      () => order.push('monitor'),
    );
    expect(order).toEqual(['scheduler', 'monitor']);
  });
});
