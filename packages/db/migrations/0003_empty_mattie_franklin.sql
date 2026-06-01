ALTER TABLE `endpoints` ADD `rate_limit_rps` integer;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `rate_limit_burst` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `last_defer_reason` text;