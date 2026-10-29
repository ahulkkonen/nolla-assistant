ALTER TABLE `chats` ADD `modes` text;--> statement-breakpoint
-- Phase-23 decision 4: a chat with the confidence trial on gets the profile defaults plus
-- confidence, so it keeps today's behaviour. Every other chat stays null (the profile default).
UPDATE `chats` SET `modes` = '["suora","perusteellinen","confidence"]' WHERE `confidence` = 1;--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `confidence`;
