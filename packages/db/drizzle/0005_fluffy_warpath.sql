CREATE TABLE `fileOrigins` (
	`userId` text NOT NULL,
	`path` text NOT NULL,
	`chatId` text NOT NULL,
	`messageId` text,
	`updatedAt` text NOT NULL,
	PRIMARY KEY(`userId`, `path`),
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fileTrash` (
	`userId` text NOT NULL,
	`id` text NOT NULL,
	`originalPath` text NOT NULL,
	`deletedAt` text NOT NULL,
	PRIMARY KEY(`userId`, `id`)
);
