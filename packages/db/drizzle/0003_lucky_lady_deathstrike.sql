CREATE TABLE `memoryConsolidations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`diff` text NOT NULL,
	`proposedUser` text NOT NULL,
	`proposedMemory` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `memoryPending` ADD `replace` text;