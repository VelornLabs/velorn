'use strict';
const http = require('node:http');
// No remote credentials. This listener exists only inside the private network
// namespace and forwards to a single owner-approved Unix socket.
async function createNamespaceProvider({ socketPath, capability }) {
  const server = http.createServer((request, response) => {
    if (request.headers.authorization && request.headers.authorization !== `Bearer ${capability}`) {
      response.writeHead(401); response.end(); return;
    }
    const upstream = http.request({ socketPath, path: request.url, method: request.method,
      headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json',
        ...(request.headers['content-encoding'] ? { 'content-encoding': request.headers['content-encoding'] } : {}) } }, result => {
      response.writeHead(result.statusCode, { 'content-type': result.headers['content-type'] || 'application/json' });
      result.pipe(response);
    });
    upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { providerUrl: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createNamespaceProvider };

