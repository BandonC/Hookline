CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	`max_in_flight` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `tenants` (`id`, `name`, `weight`) VALUES ('ten_default', 'default', 1);
--> statement-breakpoint
-- SQLite cannot add a NOT-NULL-with-default column that also carries a
-- REFERENCES clause (`Cannot add a REFERENCES column with non-NULL default
-- value`). D1 has PRAGMA foreign_keys OFF by default anyway, so the FK is
-- never enforced at runtime — drop the REFERENCES from the ALTER. The
-- relationship still lives in the Drizzle TS schema for typing/intent, and
-- the app layer validates tenant existence at POST /v1/endpoints.
ALTER TABLE `endpoints` ADD `tenant_id` text DEFAULT 'ten_default' NOT NULL;