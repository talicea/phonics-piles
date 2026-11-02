import { loadConfig } from './config';
import { createGameServer } from './gameServer';

const config = loadConfig();
const server = createGameServer(config);

server.listen().then((port) => {
  console.log(`Phonics Piles listening on http://${config.host}:${port} (${config.isProduction ? 'production' : 'development'})`);
  console.log(`Built-in decks: ${server.decks.list().length}`);
}).catch((e) => {
  console.error('Failed to start server:', e instanceof Error ? e.message : e);
  process.exit(1);
});

// Tell connected clients the session is going away rather than leaving stale interfaces behind.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig} received: shutting down`);
    void server.shutdown('server-restart').then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
