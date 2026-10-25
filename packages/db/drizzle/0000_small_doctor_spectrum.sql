CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`agentId` text DEFAULT 'assistant' NOT NULL,
	`topicId` text,
	`title` text,
	`titleMasked` text,
	`titleLocked` integer DEFAULT false,
	`pinned` integer DEFAULT false,
	`archived` integer DEFAULT false,
	`sessionFile` text NOT NULL,
	`summary` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`topicId`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chats_user_archived_updated_idx` ON `chats` (`userId`,`archived`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`chatId` text,
	`name` text,
	`mime` text,
	`size` integer,
	`path` text NOT NULL,
	`createdAt` text,
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memoryPending` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`chatId` text,
	`action` text,
	`target` text,
	`text` text,
	`status` text DEFAULT 'pending',
	`createdAt` text
);
--> statement-breakpoint
CREATE TABLE `pushSubscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`endpoint` text NOT NULL,
	`subscription` text NOT NULL,
	`createdAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pushSubscriptions_endpoint_unique` ON `pushSubscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `tags` (
	`chatId` text,
	`userId` text NOT NULL,
	`tag` text,
	PRIMARY KEY(`chatId`, `tag`),
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `topicProposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`chatId` text,
	`name` text,
	`why` text,
	`status` text DEFAULT 'pending',
	`createdAt` text,
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` text NOT NULL
);
