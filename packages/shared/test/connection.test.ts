import { strict as assert } from 'node:assert';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { createLogger } from '../src/logging/logger.js';
import { MessageConnection } from '../src/protocol/connection.js';

/** A configuration push as the core sends one: each sensor with its credentials, decrypted. */
const PUSH = {
  type: 'config-set',
  sensors: [
    {
      id: 7,
      credentials: { snmp: { community: 's3cret-community' }, ssh: { passphrase: 's3cret-pass' } },
      params: { token: 's3cret-token', authKey: 's3cret-auth', privKey: 's3cret-priv' },
    },
  ],
} as const;

describe('a message sent on a closed connection (A-50)', () => {
  it('is logged by its type alone, never with what it carries', () => {
    // At debug, through the real logger and its redact paths, which stop at depth three and so
    // never reached `message.sensors[0].credentials`.
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const logger = createLogger({ name: 'test', level: 'debug', destination });
    const socket = new PassThrough();
    const connection = new MessageConnection<unknown, typeof PUSH>({
      socket,
      logger,
      parse: (value) => value,
      onMessage: () => undefined,
      onClose: () => undefined,
    });
    socket.emit('close');
    assert.equal(connection.closed, true);

    connection.send(PUSH);
    logger.flush();
    const logged = lines.join('');
    assert.match(logged, /dropping outbound message on a closed connection/u, 'the control');
    assert.match(logged, /"type":"config-set"/u);
    assert.doesNotMatch(logged, /s3cret/u);
  });
});
