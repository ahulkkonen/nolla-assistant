import { build, loadConfig } from './index.ts';

// Runs as root inside its container: the Docker socket is root-owned on the host. The compose
// service drops every capability (cap_drop: ALL) and has no inbound path but the internal network.
const app = await build(loadConfig());
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8100) });
const shutdown = () => void app.close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
