CREATE INDEX `chunks_chat_kind_seq_idx` ON `chunks` (`chatId`,`kind`,`seq`);--> statement-breakpoint
CREATE INDEX `file_origins_chat_idx` ON `fileOrigins` (`chatId`);--> statement-breakpoint
CREATE INDEX `files_chat_idx` ON `files` (`chatId`);--> statement-breakpoint
CREATE INDEX `memory_pending_chat_idx` ON `memoryPending` (`chatId`);--> statement-breakpoint
CREATE INDEX `topic_proposals_chat_idx` ON `topicProposals` (`chatId`);