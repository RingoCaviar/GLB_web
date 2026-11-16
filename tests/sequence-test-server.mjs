import { once } from 'node:events';
import { createServer } from 'node:http';
import { createSequenceMiddleware } from '../scripts/sequence-middleware.mjs';

export async function withSequenceServer(root, run) {
  const handle = createSequenceMiddleware(root);
  const server = createServer((request, response) => {
    handle(request, response, () => {
      response.writeHead(404).end();
    });
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    return await run((path, options) => fetch(new URL(path, origin), options));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
