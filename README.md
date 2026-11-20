# Meridian

A PostgreSQL-backed distributed background job execution prototype built as a TypeScript monorepo with an Express API, a Next.js frontend, and worker processes. It demonstrates execution attempts, leases, retries, cancellation, worker recovery, and project access controls.

## Project status

This is an engineering prototype, not a hosted service or production-ready queue. The API has authentication, project and membership operations, execution lifecycle services, and database-backed email-verification delivery. Job-management and worker-management routes remain unavailable until resource access is project-scoped. The unscoped queue guard defaults to disabled, so the scheduler does not assign jobs in the default configuration. Job submission and automatic assignment are not currently usable through the public API.

The worker source currently simulates progress and occasional failure. It does not execute arbitrary developer-supplied handlers. Invitations and project archival are not implemented. The frontend provides account access and a prototype home page, but does not provide project management or a job-execution dashboard.

## Problem and execution model

The backend models jobs, workers, execution attempts, and logs in PostgreSQL. PostgreSQL is the authoritative state store. A job moves through pending, queued, running, and terminal states. Each assignment creates a numbered execution attempt. `max_retries` means retries after the initial attempt; attempt numbering starts at one. Failures and expired leases either make a retry eligible or leave the job failed when the retry limit is exhausted.

When enabled, the scheduler selects due jobs by priority and creation time and reserves a worker inside a PostgreSQL transaction. It uses row-level locks and `FOR UPDATE SKIP LOCKED` so concurrent schedulers skip rows another scheduler has claimed. The assignment transaction records the attempt and updates job and worker state together. The current implementation is a global, unscoped queue path; it is guarded off by default and is not project-fair scheduling.

Workers authenticate with registration credentials and use an attempt-specific lease token for callbacks. Heartbeats renew a lease while it is valid. Recovery finds expired attempts, closes them, and applies retry rules. Cancellation serializes against execution callbacks and moves active work toward revocation. A worker acknowledgement is not accepted until its attempt is already revoked. These mechanisms limit stale callbacks and duplicate active assignments, but do not stop arbitrary external side effects.

Execution is **at least once**, not exactly once. Lease expiry or process failure can make a retry eligible while an earlier external operation is still running. A settled task promise, a deregistered worker, or a database status of `dead` does not prove that external work stopped. Real handlers would need idempotency or external fencing.

More state and operational detail is in [the execution lifecycle document](apps/api/EXECUTION_LIFECYCLE.md).

## Architecture

- `apps/api`: Express API, authentication, project membership services, job/worker/execution services, scheduler, recovery monitor, migration runner, and readiness checks.
- `apps/web`: Next.js App Router frontend with home, login, registration, and email-verification routes.
- `packages/types`: shared TypeScript domain and API types.
- PostgreSQL: migrations, job and worker state, execution history, and email-verification delivery queue.

Project creation, membership, role changes, and ownership transfer are implemented behind authenticated project routes. Job and worker registry routes return controlled unavailable responses while project-level access controls are incomplete. The current project schema includes invitation structures, but invitation APIs are not implemented.

## Email verification

Verification requests and delivery state are stored in PostgreSQL. The delivery worker encrypts queued recipient/token material, stores token digests for verification, and uses the configured Resend adapter. The checked-in email delivery tests use a fake-provider path. Real Resend delivery, sender-domain configuration, inbox delivery, and production mail operation have not been validated. Provider acceptance would not prove inbox receipt. Invitation delivery is not available.

To enable delivery in a local environment, configure a developer-controlled Resend key, verified sender, HTTPS-capable application URL as appropriate, and `EMAIL_DELIVERY_ENCRYPTION_KEY` in the API environment. The encryption-key variable is intentionally not populated in `.env.example`; generate a random 32-byte key and store it locally or in a secret manager. Keep all these values out of source control and browser-visible variables. See [email verification operations](apps/api/EMAIL_VERIFICATION_OPERATIONS.md) for rotation and failure semantics.

## Requirements

- Node.js `>=20.9.0` (the locked Next.js package requirement).
- npm workspaces.
- PostgreSQL for API startup and migrations. The migration runner enforces PostgreSQL 12 or newer; the opt-in email-verification integration test requires PostgreSQL 16 and its dedicated guarded test endpoint.

## Local development

Install from the checked-in lockfile:

```sh
npm ci
```

Create a **new disposable local development database** before configuring the API. Copy `.env.example` to `apps/api/.env`, then replace every placeholder with local values. In particular, `DATABASE_URL` must identify only that disposable database. `UNSCOPED_QUEUE_ENABLED` must remain `false`. Do not copy credentials into the web app or commit local environment files.

The web API client defaults to `http://localhost:3001`. If a different API endpoint is needed, set `NEXT_PUBLIC_API_URL` in `apps/web/.env.local`.

Apply migrations only to the verified, newly created disposable database:

```sh
npm run migrate --workspace=apps/api
```

The runner applies the canonical migration sequence through `007c_email_delivery_and_rate_limits.sql`, and records each migration in the same transaction as its ledger entry. It does not provision a database or run automatically at API startup. Do not point it at `meridian_dev`, a shared database, or production. API startup checks readiness and refuses to start background services or the listener when required migrations/schema are missing.

Run the API and web development servers in separate terminals:

```sh
npm run dev:api
npm run dev:web
```

The API requires a reachable migrated database. With the default queue setting, the scheduler remains disabled. Job/worker management endpoints remain unavailable, so this is not an end-to-end job execution demo yet.

## Build, lint, and tests

Commands defined by the workspace manifests:

```sh
npm run build --workspace=apps/api
npm run type-check --workspace=apps/web
npm run lint --workspace=apps/web
npm run build --workspace=apps/web
npm test --workspace=apps/api
```

The API unit suite uses Vitest and Supertest; HTTP tests require loopback socket binding. In restricted environments, tests can fail with `listen EPERM`. No claim is made here that the full suite passes in every environment. The web workspace does not currently define a test suite.

There is one separate, opt-in PostgreSQL integration test for email verification. It requires an isolated PostgreSQL 16 database at `127.0.0.1:55435`, named `phase3c5d5`, using the expected non-superuser test role. It verifies that database identity before proceeding, then truncates its test tables and runs controlled schema operations. Never point it at a development, shared, or production database. After creating that disposable database and applying migrations to it, invoke the configured Vitest binary with:

```sh
EMAIL_VERIFICATION_PG_INTEGRATION=1 \
DATABASE_URL='postgresql://phase3c5d5_app:<local-password>@127.0.0.1:55435/phase3c5d5' \
npm exec --workspace=apps/api -- vitest run --config vitest.integration.config.ts
```

This integration test covers email verification only. Lifecycle concurrency and readiness catalog verification do not have a general checked-in PostgreSQL integration suite. The readiness document provides a manual procedure that must also use a disposable database.

## Current verification evidence

The source tree contains mocked API unit tests and the email-verification PostgreSQL integration test. Prior engineering reports describe a six-scenario PostgreSQL lifecycle concurrency verification, but the report artifacts and executable tests are not included in this checkout. Those results cannot be reproduced from a fresh clone and are not represented here as checked-in test coverage. The lifecycle documentation records this distinction.

## Known limitations and next work

- Project-scoped job submission, retrieval, cancellation, and worker registry operations must be completed before the queue can be activated.
- The scheduler currently has no project-fair selection path; global assignment remains disabled.
- The worker is a simulator, not an arbitrary task-handler runtime.
- Invitations and project archival are not implemented.
- Real email-provider and inbox delivery have not been established by the checked-in fake-provider integration test.
- The frontend does not yet provide project management, job submission, execution monitoring, or worker management interfaces.
- Lifecycle concurrency evidence should be made reproducible with checked-in PostgreSQL tests or a checked-in verification procedure and retained results.
- Deployment, backups, monitoring, and production operational procedures remain outside this prototype's validated scope.

Do not enable the unscoped queue for public use. This repository is an engineering showcase, not a production-ready job service.
