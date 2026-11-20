import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { discoverMigrationFiles, validateMigrationHistory, type MigrationLedgerEntry } from './migration-history';

export async function runMigrations(customPool?: Pool): Promise<string[]> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !customPool) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = customPool ?? new Pool({ connectionString: databaseUrl });
  const applied: string[] = [];

  try {
    const { rows: versionRows } = await pool.query<{ server_version_num: number | string }>(
      `SELECT current_setting('server_version_num')::integer AS server_version_num`,
    );
    const serverVersion = Number(versionRows[0]?.server_version_num);
    if (!Number.isFinite(serverVersion) || serverVersion < 120000) {
      throw new Error(`PostgreSQL 12 or newer is required for transactional enum migrations; found ${versionRows[0]?.server_version_num ?? 'unknown'}`);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = discoverMigrationFiles(migrationsDir);

    const { rows: ledger } = await pool.query<MigrationLedgerEntry>(
      'SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at ASC',
    );
    validateMigrationHistory(ledger, false);

    for (const filename of files) {
      if (ledger.some((entry) => entry.filename === filename)) {
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf-8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename],
        );
        await client.query('COMMIT');
        applied.push(filename);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return applied;
  } finally {
    if (!customPool) {
      await pool.end();
    }
  }
}

if (require.main === module) {
  runMigrations()
    .then((applied) => {
      console.log(`Migrations complete. Applied ${applied.length} files.`);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
