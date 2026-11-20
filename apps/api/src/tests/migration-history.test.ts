import { describe, expect, it } from 'vitest';
import { MIGRATION_SEQUENCE, validateMigrationHistory } from '../db/migration-history';

function ledgerThrough(index: number) {
  return MIGRATION_SEQUENCE.slice(0, index + 1).map((filename, order) => ({
    filename,
    applied_at: new Date(Date.UTC(2026, 0, 1, 0, 0, order)),
  }));
}

describe('migration history validation', () => {
  it('accepts a normal complete ordered history', () => {
    expect(() => validateMigrationHistory(ledgerThrough(MIGRATION_SEQUENCE.length - 1), true)).not.toThrow();
  });

  it('accepts a clean ledger and a pending suffix', () => {
    expect(() => validateMigrationHistory([], false)).not.toThrow();
    expect(() => validateMigrationHistory(ledgerThrough(7), false)).not.toThrow();
  });

  it('rejects a missing predecessor when a later migration is recorded', () => {
    const history = ledgerThrough(8).filter(({ filename }) => filename !== '007a_execution_log_association.sql');
    expect(() => validateMigrationHistory(history, false)).toThrow('missing predecessor migrations');
  });

  it('rejects an unknown migration', () => {
    expect(() => validateMigrationHistory([
      ...ledgerThrough(0),
      { filename: '009_unknown.sql', applied_at: new Date(Date.UTC(2026, 0, 1, 0, 1)) },
    ], false)).toThrow('unknown migration ledger entries: 009_unknown.sql');
  });

  it('rejects duplicate ledger rows', () => {
    const history = ledgerThrough(0);
    expect(() => validateMigrationHistory([...history, history[0]], false)).toThrow('duplicate migration ledger entries');
  });

  it('rejects a fully present but out-of-order history', () => {
    const history = ledgerThrough(MIGRATION_SEQUENCE.length - 1);
    const first = history[0];
    const second = history[1];
    const firstTime = first.applied_at;
    first.applied_at = second.applied_at;
    second.applied_at = firstTime;
    expect(() => validateMigrationHistory(history, true)).toThrow('out-of-order migration history');
  });

  it('rejects a clean ledger when readiness requires the full sequence', () => {
    expect(() => validateMigrationHistory([], true)).toThrow('missing migrations');
  });
});
