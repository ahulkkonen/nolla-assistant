import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { sandboxExtension } from './index.ts';

/**
 * Entry for a child Pi process (`pi -e <this file>`, phase-5 decision 5). Reads its config from
 * env and fails closed: without the broker settings the child does not start.
 */
const { BROKER_URL, BROKER_TOKEN, USER_ID, PA_PARENT_CHAT_ID } = process.env;
if (!BROKER_URL || !BROKER_TOKEN || !USER_ID || !PA_PARENT_CHAT_ID)
  throw new Error(
    'pi-ext-sandbox cli: BROKER_URL, BROKER_TOKEN, USER_ID and PA_PARENT_CHAT_ID are required',
  );

const extension: ExtensionFactory = sandboxExtension({
  brokerUrl: BROKER_URL,
  token: BROKER_TOKEN,
  userId: USER_ID,
  chatId: PA_PARENT_CHAT_ID,
});
export default extension;
