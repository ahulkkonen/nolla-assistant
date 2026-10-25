import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { PseudoClient } from './client.ts';
import { pseudoExtension } from './index.ts';

/**
 * Entry for a child Pi process (`pi -e <this file>`, phase-5 decision 5). Reads its config from
 * env and fails closed: without `PSEUDO_URL` the child does not start.
 */
const { PSEUDO_URL, USER_ID, PA_SESSION_ID, PA_PARENT_CHAT_ID } = process.env;
if (!PSEUDO_URL || !USER_ID || !PA_SESSION_ID)
  throw new Error('pi-ext-pseudo cli: PSEUDO_URL, USER_ID and PA_SESSION_ID are required');

const extension: ExtensionFactory = pseudoExtension({
  client: new PseudoClient(PSEUDO_URL, USER_ID),
  sessionId: PA_SESSION_ID,
  // stderr is the child's diagnostics channel; the logs carry kinds, ids and lengths only.
  log: (level, msg, data) =>
    console.error(JSON.stringify({ level, msg, parentChatId: PA_PARENT_CHAT_ID, ...data })),
});
export default extension;
