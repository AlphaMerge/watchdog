// A heartbeat receiver for a smoke box (`H-25`): what a dead man's switch service would be told.
//
//     node heartbeat-receiver.mjs PORT LOG
//
// Listens on 127.0.0.1:PORT and answers every request 200. Appends one line per request to LOG:
// the method, the path with its query, and the User-Agent, separated by single spaces. Run under
// `systemd-run` so the smoke test can stop it and see the core count what no longer arrives.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [port, log] = process.argv.slice(2);
if (port === undefined || log === undefined) {
  process.stderr.write('usage: heartbeat-receiver.mjs PORT LOG\n');
  process.exit(2);
}

createServer((request, response) => {
  appendFileSync(
    log,
    `${request.method ?? '-'} ${request.url ?? '-'} ${request.headers['user-agent'] ?? '-'}\n`,
  );
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('ok\n');
}).listen(Number(port), '127.0.0.1');
