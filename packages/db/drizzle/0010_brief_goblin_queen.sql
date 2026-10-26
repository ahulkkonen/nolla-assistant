ALTER TABLE `chats` ADD `claimsRetryAt` text;--> statement-breakpoint
ALTER TABLE `evidence` ADD `supersededBy` integer;--> statement-breakpoint
ALTER TABLE `evidence` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `evidence` ADD `validTo` text;--> statement-breakpoint
CREATE INDEX `evidence_superseded_by_idx` ON `evidence` (`supersededBy`);--> statement-breakpoint
-- Phase 17: chats from before the claims tables are not mined (no historical backlog).
UPDATE `chats` SET `claimsAt` = `updatedAt` WHERE `claimsAt` IS NULL;--> statement-breakpoint
-- Automation chats that can be told apart: the last run's chat and chats in the Automaatiot topic.
UPDATE `chats` SET `fromAutomation` = 1
  WHERE `id` IN (SELECT `lastChatId` FROM `automationRuns` WHERE `lastChatId` IS NOT NULL)
     OR `topicId` IN (SELECT `id` FROM `topics` WHERE `name` = 'Automaatiot');
