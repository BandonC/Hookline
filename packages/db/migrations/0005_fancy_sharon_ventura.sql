ALTER TABLE `endpoints` ADD `circuit_breaker_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `breaker_open_sec` integer;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `breaker_threshold_pct` integer;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `breaker_state` text DEFAULT 'closed' NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `breaker_opened_at` integer;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `breaker_open_until` integer;