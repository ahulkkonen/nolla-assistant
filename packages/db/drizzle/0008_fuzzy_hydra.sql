ALTER TABLE `chats` ADD `input` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `output` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `cacheRead` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `cacheWrite` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `chats` SET
  `input` = coalesce((SELECT sum(`input`) FROM `usage` WHERE `usage`.`chatId` = `chats`.`id`), 0),
  `output` = coalesce((SELECT sum(`output`) FROM `usage` WHERE `usage`.`chatId` = `chats`.`id`), 0),
  `cacheRead` = coalesce((SELECT sum(`cacheRead`) FROM `usage` WHERE `usage`.`chatId` = `chats`.`id`), 0),
  `cacheWrite` = coalesce((SELECT sum(`cacheWrite`) FROM `usage` WHERE `usage`.`chatId` = `chats`.`id`), 0);
