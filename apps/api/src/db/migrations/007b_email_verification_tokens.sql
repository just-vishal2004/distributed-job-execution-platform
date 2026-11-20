CREATE TABLE email_verification_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  email      TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  revoked_at  TIMESTAMPTZ NULL,

  CONSTRAINT email_verification_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT email_verification_tokens_email_normalized_check
    CHECK (email = lower(email) AND email = btrim(email)),
  CONSTRAINT email_verification_tokens_hash_format_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_verification_tokens_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT email_verification_tokens_terminal_state_check
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX uq_email_verification_tokens_hash
  ON email_verification_tokens(token_hash);
CREATE UNIQUE INDEX uq_email_verification_tokens_outstanding_user_email
  ON email_verification_tokens(user_id, email)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
