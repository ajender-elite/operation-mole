import { setupServer } from 'msw/node';
import { serverInfoHandler } from './handlers.ts';

/** Mock API server; tests register handlers with `server.use(...)`. The server's info is answered by default. */
export const server = setupServer(serverInfoHandler());
