# Email verification operations

Email verification requests are written to `email_verification_requests` before the API returns. The address is encrypted. A separate PostgreSQL-backed worker resolves the account and creates the token digest plus encrypted delivery row in one transaction. The normal job scheduler and simulated worker queue are not used.

`EMAIL_DELIVERY_ENCRYPTION_KEY` must be canonical base64 encoding of 32 random bytes. Configure the same value on every API instance and keep it stable while encrypted request or delivery rows remain. It protects queued addresses and raw verification tokens with AES-256-GCM. Changing it makes existing queued values unreadable; affected records are marked failed and the user must request a new link after the key is corrected. Do not log or commit the key.

Delivery uses a 5 second provider request timeout, a 30 second database lease, and at most five claimed attempts. Network failures, HTTP 429 responses, and provider 5xx responses retry after exponential delays based on 15, 30, 60, then 120 seconds, each with 0.5x to 1.5x jitter. Other provider 4xx responses fail immediately. The fifth retryable failure becomes terminal. A user can request another link to replace a failed or pending token. Each attempt reuses `email-verification/<token-id>` as the Resend idempotency key. This provides provider-assisted duplicate suppression, not exactly-once delivery. A provider timeout may leave the send outcome uncertain.

The delivery transaction holds the user, token, and delivery row locks while making the bounded provider call. Worker transactions use a 5 second PostgreSQL lock timeout and a 10 second statement timeout. This serializes token replacement and confirmation with the send. It also means a request for that same user can wait for up to the provider timeout plus database work.

Shared rate limits use HMAC-SHA-256 keys. The request limits are 10 per source IP per hour, 3 per recipient per hour, and 10 per recipient per UTC day. Recipient-limit hits are silently suppressed behind the same 202 response. The IP limit is 10 per hour so a person can request replacements without being limited to one daily request, while repeated sends to one mailbox are capped. Confirmation attempts are limited to 30 per IP per hour and 10 per token per hour. IP and token limits return controlled 429 or generic invalid-link responses. Rate-limit database errors fail closed with a generic 503.

Rate-limit buckets expire after their bucket plus one day. The API periodically deletes at most 2,000 expired rows per cleanup pass. Terminal request and delivery rows older than 30 days are deleted in batches of at most 500 by the delivery worker.

Migration history follows the canonical lexical sequence in `migration-history.ts`. The runner rejects unknown, duplicate, gapped, or out-of-order ledgers before applying files. Readiness requires the complete sequence through `007c_email_delivery_and_rate_limits.sql`. Review an inconsistent database and its schema manually; the runner does not repair ledger history.

## Required configuration

The API requires `DATABASE_URL` and `JWT_SECRET`. Email verification delivery additionally requires `RESEND_API_KEY`, `EMAIL_FROM` on a sender domain verified with Resend, `APP_BASE_URL`, and `EMAIL_DELIVERY_ENCRYPTION_KEY`. Production configuration validation rejects missing Resend settings or an encryption key. Keep provider and encryption credentials server side. Keep `UNSCOPED_QUEUE_ENABLED=false` while the global queue is not project scoped.

Do not put real credentials in this file, source control, frontend variables, command output, or test reports. Configure production values through the deployment secret manager. For a real delivery test, use a separate Resend key and verified test sender plus an inbox controlled by the developer. The application does not provide a safe way to prove that an arbitrary recipient is developer controlled.

## Encryption-key backup and rotation

Back up the exact `EMAIL_DELIVERY_ENCRYPTION_KEY` in the organization's protected secret backup system. Access to the backup should be restricted and audited like access to the live secret. The database alone cannot recover encrypted queued addresses or verification tokens. Restoring the same key on every API instance restores decryption. Generating a replacement key does not.

There is no key version or multi-key decrypt support. Do not rotate the key while encrypted request or delivery rows remain. Before a planned rotation, stop new verification requests, allow the worker to drain pending rows, confirm no pending or leased rows remain using aggregate state counts, then update every instance together. If the key is lost or changed while rows are pending, those rows cannot be decrypted; they fail safely and users need to request a new link after the correct key is restored or a planned rotation is completed.

## Worker lifecycle and recovery

The API checks database readiness before starting background services. Each API process starts its own email delivery timer after readiness; PostgreSQL row locks and leases coordinate the instances. The simulated job scheduler is not used for email delivery.

There is currently no dedicated graceful-stop hook for the email timer. On process termination, an open database transaction rolls back and releases its locks. A delivery claimed before termination remains leased until its 30 second lease expires, then another worker can claim it. If a provider accepted the message immediately before a process died, the next attempt may repeat the send. The same Resend idempotency key is used for that logical token, but provider idempotency is not an exactly-once guarantee and its retention window is controlled by Resend.

Use aggregate state and attempt counts to diagnose delivery health without selecting recipient, ciphertext, token hash, lease token, or verification URL fields:

```sql
SELECT state, count(*) AS deliveries, max(attempt_count) AS highest_attempt
FROM email_verification_deliveries
GROUP BY state
ORDER BY state;
```

Application logs use fixed event names and safe provider status metadata. They intentionally omit recipient addresses, raw tokens, complete verification URLs, encryption keys, and provider response bodies. A terminal `failed` row does not reveal the recipient or failure payload. The user can safely request another link through `POST /api/auth/email-verification/request`; the endpoint returns the same generic accepted response whether or not an account needs verification.

## Provider acceptance versus inbox delivery

The delivery state `delivered` means the Resend API returned a successful acceptance response and the worker committed that result. It does not prove delivery to the destination mailbox, inbox placement, or that the recipient opened the message. The current adapter does not retain a provider message ID or consume delivery webhooks. A controlled test must separately inspect the developer-owned inbox and report provider acceptance and inbox receipt as distinct outcomes.

The checked-in PostgreSQL integration test replaces the provider with a fake local HTTP service. It validates database and worker behavior but does not send a real Resend message or establish provider acceptance or inbox delivery. Real-provider operation remains unverified until a separately controlled test uses a developer-owned Resend account, verified sender, and inbox.

The verification email states that its link expires in 24 hours, matching the token expiry written by the worker. The token is placed in the URL fragment, which is not sent in the initial HTTP request. The `/verify-email` page reads the fragment, removes it from the address bar, and submits the token in the confirmation POST body. Avoid capturing or sharing the link or browser state during operational testing.
