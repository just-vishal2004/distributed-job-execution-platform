CREATE TABLE email_verification_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_ciphertext BYTEA NULL,
  nonce           BYTEA NULL,
  auth_tag         BYTEA NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at    TIMESTAMPTZ NULL,
  CONSTRAINT email_verification_requests_state_check
    CHECK (state IN ('pending', 'processed', 'not_needed', 'failed')),
  CONSTRAINT email_verification_requests_payload_check
    CHECK (
      (state = 'pending' AND email_ciphertext IS NOT NULL
        AND nonce IS NOT NULL AND auth_tag IS NOT NULL
        AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16)
      OR
      (state IN ('processed', 'not_needed', 'failed') AND email_ciphertext IS NULL
        AND nonce IS NULL AND auth_tag IS NULL)
    ),
  CONSTRAINT email_verification_requests_terminal_check
    CHECK ((state = 'pending') = (processed_at IS NULL))
);

CREATE INDEX idx_email_verification_requests_pending
  ON email_verification_requests(created_at, id)
  WHERE state = 'pending';

CREATE INDEX idx_email_verification_requests_terminal
  ON email_verification_requests(processed_at, id)
  WHERE state <> 'pending';

CREATE TABLE email_verification_deliveries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_token_id UUID NOT NULL UNIQUE
    REFERENCES email_verification_tokens(id) ON DELETE CASCADE,
  ciphertext            BYTEA NULL,
  nonce                 BYTEA NULL,
  auth_tag              BYTEA NULL,
  state                 TEXT NOT NULL DEFAULT 'pending',
  attempt_count         SMALLINT NOT NULL DEFAULT 0,
  available_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_id              UUID NULL,
  lease_expires_at      TIMESTAMPTZ NULL,
  delivered_at          TIMESTAMPTZ NULL,
  terminal_at           TIMESTAMPTZ NULL,
  last_failure_kind     TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT email_verification_deliveries_state_check
    CHECK (state IN ('pending', 'leased', 'delivered', 'failed', 'cancelled')),
  CONSTRAINT email_verification_deliveries_attempts_check
    CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT email_verification_deliveries_cipher_check
    CHECK (
      (state IN ('pending', 'leased')
        AND ciphertext IS NOT NULL
        AND nonce IS NOT NULL
        AND auth_tag IS NOT NULL
        AND octet_length(nonce) = 12
        AND octet_length(auth_tag) = 16)
      OR
      (state IN ('delivered', 'failed', 'cancelled')
        AND ciphertext IS NULL
        AND nonce IS NULL
        AND auth_tag IS NULL)
    ),
  CONSTRAINT email_verification_deliveries_lease_check
    CHECK ((state = 'leased') = (lease_id IS NOT NULL)),
  CONSTRAINT email_verification_deliveries_lease_fields_check
    CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT email_verification_deliveries_terminal_check
    CHECK ((state IN ('delivered', 'failed', 'cancelled')) = (terminal_at IS NOT NULL)),
  CONSTRAINT email_verification_deliveries_delivery_time_check
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT email_verification_deliveries_failure_check
    CHECK (last_failure_kind IS NULL OR last_failure_kind IN ('provider', 'network'))
);

CREATE INDEX idx_email_verification_deliveries_pending
  ON email_verification_deliveries(available_at, created_at, id)
  WHERE state = 'pending';

CREATE INDEX idx_email_verification_deliveries_expired_lease
  ON email_verification_deliveries(lease_expires_at, created_at, id)
  WHERE state = 'leased';

CREATE INDEX idx_email_verification_deliveries_terminal
  ON email_verification_deliveries(terminal_at, id)
  WHERE state IN ('delivered', 'failed', 'cancelled');

CREATE TABLE email_verification_rate_limits (
  key_hash          TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count     INTEGER NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT email_verification_rate_limits_hash_check
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_verification_rate_limits_count_check
    CHECK (request_count > 0),
  CONSTRAINT email_verification_rate_limits_expiry_check
    CHECK (expires_at > window_started_at)
);

CREATE INDEX idx_email_verification_rate_limits_expiry
  ON email_verification_rate_limits(expires_at);
