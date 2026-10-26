CREATE TABLE `claimEntities` (
	`claimId` integer NOT NULL,
	`entityId` integer NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`claimId`, `entityId`),
	FOREIGN KEY (`claimId`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claim_entities_entity_idx` ON `claimEntities` (`userId`,`entityId`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`subjectEntityId` integer,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`confidence` real NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`activatedBy` text,
	`validFrom` text,
	`validTo` text,
	`recordedAt` text NOT NULL,
	`supersedesId` integer,
	`sourceChatId` text,
	`lastConfirmedAt` text,
	`timesSeen` integer DEFAULT 1 NOT NULL,
	`reviewedAt` text,
	`checkedAt` text,
	`inProfile` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`supersedesId`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claims_user_status_idx` ON `claims` (`userId`,`status`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`claimId` integer NOT NULL,
	`chatId` text,
	`messageId` text,
	`quote` text NOT NULL,
	`stance` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`claimId`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evidence_claim_idx` ON `evidence` (`claimId`);--> statement-breakpoint
ALTER TABLE `chats` ADD `tainted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `fromAutomation` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `claimsThrough` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `claimsAt` text;