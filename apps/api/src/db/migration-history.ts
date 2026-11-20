import fs from 'fs';

export const MIGRATION_SEQUENCE = [
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
] as const;

export type MigrationLedgerEntry = {
  filename: string;
  applied_at: Date | string;
};

export function discoverMigrationFiles(directory: string): string[] {
  const discovered = fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
  const expected = [...MIGRATION_SEQUENCE];
  if (discovered.length !== expected.length
    || discovered.some((filename, index) => filename !== expected[index])) {
    throw new Error(
      `Migration files do not match the canonical sequence. Expected: ${expected.join(', ')}. Found: ${discovered.join(', ')}`,
    );
  }
  return discovered;
}

export function validateMigrationHistory(
  entries: readonly MigrationLedgerEntry[],
  requireComplete: boolean,
): void {
  const knownIndex = new Map<string, number>(MIGRATION_SEQUENCE.map((filename, index) => [filename, index]));
  const counts = new Map<string, number>();
  for (const { filename } of entries) {
    counts.set(filename, (counts.get(filename) ?? 0) + 1);
  }

  const duplicates = [...counts].filter(([, count]) => count > 1).map(([filename]) => filename);
  if (duplicates.length > 0) {
    throw new Error(`duplicate migration ledger entries: ${duplicates.join(', ')}`);
  }

  const unknown = [...counts.keys()].filter((filename) => !knownIndex.has(filename));
  if (unknown.length > 0) {
    throw new Error(`unknown migration ledger entries: ${unknown.join(', ')}`);
  }

  const sorted = [...entries].sort((left, right) => {
    const leftTime = new Date(left.applied_at).getTime();
    const rightTime = new Date(right.applied_at).getTime();
    return leftTime - rightTime;
  });

  for (let index = 1; index < sorted.length; index++) {
    const previousTime = new Date(sorted[index - 1].applied_at).getTime();
    const currentTime = new Date(sorted[index].applied_at).getTime();
    if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime) || previousTime === currentTime) {
      throw new Error(
        `ambiguous migration application order: ${sorted[index - 1].filename}, ${sorted[index].filename}`,
      );
    }
  }

  const appliedIndexes: number[] = [];
  for (const { filename } of sorted) {
    const index = knownIndex.get(filename);
    if (index === undefined) continue;
    appliedIndexes.push(index);
  }
  for (let index = 1; index < appliedIndexes.length; index++) {
    if (appliedIndexes[index] < appliedIndexes[index - 1]) {
      throw new Error(
        `out-of-order migration history: ${sorted[index - 1].filename} was recorded before ${sorted[index].filename}`,
      );
    }
  }

  if (appliedIndexes.length > 0) {
    const highestApplied = Math.max(...appliedIndexes);
    const missingPredecessors = MIGRATION_SEQUENCE
      .slice(0, highestApplied + 1)
      .filter((filename) => !counts.has(filename));
    if (missingPredecessors.length > 0) {
      throw new Error(
        `missing predecessor migrations before an applied later migration: ${missingPredecessors.join(', ')}`,
      );
    }
  }

  if (requireComplete) {
    const missing = MIGRATION_SEQUENCE.filter((filename) => !counts.has(filename));
    if (missing.length > 0) throw new Error(`missing migrations: ${missing.join(', ')}`);
  }
}
