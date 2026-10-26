CREATE TABLE `modelFavorites` (
	`userId` text NOT NULL,
	`modelId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`userId`, `modelId`)
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `modelId` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `reasoning` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `dataPolicy` text DEFAULT 'zdr' NOT NULL;