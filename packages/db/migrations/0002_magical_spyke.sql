ALTER TABLE `events` ADD `ordering_key` text;--> statement-breakpoint
CREATE INDEX `ordered_head_idx` ON `events` (`endpoint_id`,`ordering_key`,`status`,`created_at`);