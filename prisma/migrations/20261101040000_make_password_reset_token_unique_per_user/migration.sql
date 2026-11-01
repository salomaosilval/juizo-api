DROP INDEX "password_reset_tokens_user_id_idx";

CREATE UNIQUE INDEX "password_reset_tokens_user_id_key" ON "password_reset_tokens"("user_id");
