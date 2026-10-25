import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** Reports each settled run (plan §8). The title job itself lives in the server. */
export function topicsExtension(opts: {
  onSettled: (info: { sessionId: string; aborted: boolean }) => void;
}): ExtensionFactory {
  return (pi) => {
    pi.on('agent_settled', (event, ctx) => {
      opts.onSettled({ sessionId: ctx.sessionManager.getSessionId(), aborted: event.aborted });
    });
  };
}
