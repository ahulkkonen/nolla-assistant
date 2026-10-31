/**
 * The model picker over the socket: `models.state` (catalog, Auto, favourites), favourites, and
 * the server check of a model choice that `chat.create` and `chat.setModel` use.
 *
 * It must not change a chat's model or data policy (bridge/chats.ts does) and must not refresh
 * the catalog (pi/models.ts does).
 */
import { modelFavorites } from '@pa/db';
import type { ClientMessage, ModelChoice, ServerMessage } from '@pa/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { AUTO_MODEL, resolveModelId } from '../pi/models.ts';
import { errorMsg, send } from '../socket.ts';
import type { Conn } from './connection.ts';

export const modelsState = ({ db, userId, catalog }: Conn): ServerMessage => ({
  type: 'models.state',
  auto: AUTO_MODEL,
  favorites: db
    .select({ modelId: modelFavorites.modelId })
    .from(modelFavorites)
    .where(eq(modelFavorites.userId, userId))
    .orderBy(asc(modelFavorites.createdAt))
    .all()
    .map((f) => f.modelId),
  catalog: catalog.list().map(({ maxTokens: _, cacheRead: __, cacheWrite: ___, ...m }) => m),
  latest: catalog.latest(),
  fetchedAt: catalog.fetchedAt(),
});

/** Phase-10 server validation: a catalog model, and an effort that the model offers. */
export const validChoice = ({ catalog }: Conn, { modelId, reasoning }: ModelChoice) => {
  const m = catalog.get(resolveModelId(modelId));
  if (modelId !== 'auto' && !m) return false;
  return reasoning === 'auto' || !!m?.reasoning?.efforts.includes(reasoning);
};

export function favorite(conn: Conn, msg: Extract<ClientMessage, { type: 'models.favorite' }>) {
  const { db, userId, catalog, socket } = conn;
  if (msg.favorite) {
    if (!catalog.get(msg.modelId)) return send(socket, errorMsg('bad_message'));
    db.insert(modelFavorites)
      .values({ userId, modelId: msg.modelId, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  } else
    db.delete(modelFavorites)
      .where(and(eq(modelFavorites.userId, userId), eq(modelFavorites.modelId, msg.modelId)))
      .run();
  // Other screens read the favourites at their next `models.list`.
  return send(socket, modelsState(conn));
}
