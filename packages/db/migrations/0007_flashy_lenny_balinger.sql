-- Per-endpoint ingest_key: the inbound publish credential for POST /v1/events,
-- separate from the outbound signing_secret. SQLite cannot ADD a NOT NULL column
-- without a constant default, and a constant default would hand every existing
-- endpoint the SAME key (it's a credential — unacceptable). So add it nullable,
-- then backfill each existing row with its own random value. New endpoints always
-- supply ingest_key explicitly at POST /v1/endpoints, so it is never NULL in
-- steady state — the Drizzle schema marks it NOT NULL to reflect that intent
-- (same schema-vs-DDL divergence as the dropped REFERENCES in 0006_next_korath).
ALTER TABLE `endpoints` ADD `ingest_key` text;
--> statement-breakpoint
UPDATE `endpoints` SET `ingest_key` = 'ingk_' || lower(hex(randomblob(32))) WHERE `ingest_key` IS NULL;
