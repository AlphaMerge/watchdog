import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import snmp from 'net-snmp';
import { SnmpError, SnmpSession, type SnmpCredentials } from '../src/support/snmp/index.js';

/**
 * A real SNMPv3 conversation: engine discovery, authentication and privacy (`T-01`).
 *
 * **Against `net-snmp`'s own agent, and not the hand-written one beside it.** The v1/v2c tests
 * use ours because what they need is an agent that *misbehaves* — drops a datagram, walks
 * backwards, never answers. v3 needs the opposite: USM is engine discovery, key localisation and
 * a cipher, and a reimplementation of that in a test agent would only prove the two halves of
 * one mistake agree.
 *
 * **An empty MIB is enough, and is the point.** Every request here comes back `NoSuchObject` —
 * which is a *successful* v3 exchange. Getting that answer means the engine was discovered, the
 * message authenticated and, at authPriv, the scoped PDU decrypted; wrong credentials do not
 * produce it, they produce a timeout or a USM report. So the assertion is "the agent answered at
 * all", and the negative tests below are what give that teeth.
 */

const ANY_OID = '1.3.6.1.2.1.1.1.0';

const AUTH_KEY = 'auth-key-at-least-eight';
const PRIV_KEY = 'priv-key-at-least-eight';

let agent: snmp.Agent;
let port = 0;

before(async () => {
  const { createSocket } = await import('node:dgram');
  // Take a free port from the OS, then let it go and hand the number to the agent: net-snmp's
  // listener binds a port rather than reporting the one it got.
  const probe = createSocket('udp4');
  await new Promise<void>((resolve) => {
    probe.bind(0, '127.0.0.1', () => {
      resolve();
    });
  });
  port = probe.address().port;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });

  agent = snmp.createAgent({ port, address: '127.0.0.1', disableAuthorization: false }, () => {
    // The agent's request callback. Nothing to do: the MIB is empty on purpose.
  });

  const authorizer = agent.getAuthorizer();
  authorizer.addUser({
    name: 'authpriv-user',
    level: snmp.SecurityLevel['authPriv'] ?? 3,
    authProtocol: snmp.AuthProtocols['sha'] ?? 0,
    authKey: AUTH_KEY,
    privProtocol: snmp.PrivProtocols['aes'] ?? 0,
    privKey: PRIV_KEY,
  });
  authorizer.addUser({
    name: 'auth-user',
    level: snmp.SecurityLevel['authNoPriv'] ?? 2,
    authProtocol: snmp.AuthProtocols['sha256'] ?? 0,
    authKey: AUTH_KEY,
  });
  authorizer.addUser({
    name: 'plain-user',
    level: snmp.SecurityLevel['noAuthNoPriv'] ?? 1,
  });
});

after(() => {
  agent.close();
});

function ask(credentials: SnmpCredentials, timeoutMs = 1_500): Promise<unknown> {
  const session = SnmpSession.open({ host: '127.0.0.1', port }, credentials, {
    timeoutMs,
    retries: 0,
  });
  const controller = new AbortController();
  return session.get([ANY_OID], controller.signal).finally(() => {
    session.close();
  });
}

describe('SNMPv3 at authPriv', () => {
  it('authenticates and encrypts against a real agent', async () => {
    // Reaching a varbind at all means discovery, SHA authentication and AES decryption all
    // worked. The MIB is empty, so the answer is NoSuchObject — an answer, which is the assertion.
    const varbinds = (await ask({
      version: 'v3',
      username: 'authpriv-user',
      level: 'authPriv',
      authProtocol: 'sha',
      authKey: AUTH_KEY,
      privProtocol: 'aes',
      privKey: PRIV_KEY,
    })) as { type: string }[];
    assert.equal(varbinds.length, 1);
    assert.equal(varbinds[0]?.type, 'NoSuchObject');
  });

  it('fails on a wrong authentication key', async () => {
    // The test that gives the one above its meaning: if authentication were not really
    // happening, this would succeed too.
    await assert.rejects(
      () =>
        ask({
          version: 'v3',
          username: 'authpriv-user',
          level: 'authPriv',
          authProtocol: 'sha',
          authKey: 'the-wrong-auth-key-entirely',
          privProtocol: 'aes',
          privKey: PRIV_KEY,
        }),
      SnmpError,
    );
  });

  it('fails on a wrong privacy key', async () => {
    await assert.rejects(
      () =>
        ask({
          version: 'v3',
          username: 'authpriv-user',
          level: 'authPriv',
          authProtocol: 'sha',
          authKey: AUTH_KEY,
          privProtocol: 'aes',
          privKey: 'the-wrong-priv-key-entirely',
        }),
      SnmpError,
    );
  });

  it('fails on an unknown user', async () => {
    await assert.rejects(
      () =>
        ask({
          version: 'v3',
          username: 'nobody',
          level: 'authPriv',
          authProtocol: 'sha',
          authKey: AUTH_KEY,
          privProtocol: 'aes',
          privKey: PRIV_KEY,
        }),
      SnmpError,
    );
  });
});

describe('SNMPv3 at authNoPriv', () => {
  it('authenticates with SHA-256 and sends the values in clear', async () => {
    const varbinds = (await ask({
      version: 'v3',
      username: 'auth-user',
      level: 'authNoPriv',
      authProtocol: 'sha256',
      authKey: AUTH_KEY,
    })) as { type: string }[];
    assert.equal(varbinds[0]?.type, 'NoSuchObject');
  });

  it('fails when the authentication protocol does not match the agent', async () => {
    // There is no negotiation in USM. The agent computes the digest with its own protocol and
    // the message fails to authenticate — which is a timeout, not a helpful reply.
    await assert.rejects(
      () =>
        ask({
          version: 'v3',
          username: 'auth-user',
          level: 'authNoPriv',
          authProtocol: 'md5',
          authKey: AUTH_KEY,
        }),
      SnmpError,
    );
  });
});

describe('SNMPv3 at noAuthNoPriv', () => {
  it('talks to an agent that asks for nothing', async () => {
    const varbinds = (await ask({
      version: 'v3',
      username: 'plain-user',
      level: 'noAuthNoPriv',
    })) as { type: string }[];
    assert.equal(varbinds[0]?.type, 'NoSuchObject');
  });
});
