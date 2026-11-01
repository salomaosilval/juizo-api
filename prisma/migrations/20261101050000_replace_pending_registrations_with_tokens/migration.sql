DROP TABLE "pending_registrations";

CREATE TABLE "registration_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "registration_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "registration_tokens_token_hash_key" ON "registration_tokens"("token_hash");

CREATE INDEX "registration_tokens_email_idx" ON "registration_tokens"("email");

CREATE INDEX "registration_tokens_expires_at_idx" ON "registration_tokens"("expires_at");
