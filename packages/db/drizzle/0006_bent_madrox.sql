CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`chatId` text,
	`agentId` text,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cacheRead` integer NOT NULL,
	`cacheWrite` integer NOT NULL,
	`reasoning` integer NOT NULL,
	`costUsd` real NOT NULL,
	`estimated` integer NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_user_created_idx` ON `usage` (`userId`,`createdAt`);--> statement-breakpoint
ALTER TABLE `chats` ADD `costUsd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `forkedFromChatId` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `forkedFromMessageId` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `forkedAt` text;