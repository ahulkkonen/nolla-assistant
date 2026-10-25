CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`chatId` text NOT NULL,
	`kind` text NOT NULL,
	`messageId` text,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunks_user_chat_idx` ON `chunks` (`userId`,`chatId`);