CREATE TABLE `automationRuns` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`lastRunAt` text NOT NULL,
	`lastStatus` text NOT NULL,
	`lastChatId` text,
	`lastError` text
);
