import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { TargetPolicy } from '@ms/shared';
import { fetchHttp, type HttpRequestOptions } from '../src/support/http/request.js';

/**
 * What an HTTP sensor is allowed to reach (`A-09`).
 *
 * **The guard existed for webhooks and not for sensors, which is the gap this closes.** Both
 * fetch a URL somebody typed; only one of them was checked. An HTTP sensor is the better vector
 * of the two, because a sensor's *response* is stored and rendered — so credentials taken from a
 * metadata service end up on a dashboard rather than merely in flight.
 *
 * **The default blocks link-local and nothing else, and that is the whole design.** A monitoring
 * system fetches URLs inside the network it watches; a guard that refused private addresses
 * would make the HTTP sensor useless and be switched off within the hour, which is a worse
 * outcome than a narrow guard nobody disables.
 */

describe('an HTTP sensor’s target policy', () => {
  const request = (host: string, policy?: TargetPolicy, port = 80) => {
    // Built as a typed value rather than spread in: under `exactOptionalPropertyTypes` a
    // conditional spread widens the property to include `undefined`, which the option's own
    // type deliberately does not accept.
    const options: HttpRequestOptions = {
      host,
      port,
      scheme: 'http',
      path: '/',
      method: 'GET',
      headers: {},
      body: '',
      timeoutMs: 500,
      maxRedirects: 0,
      maxBodyBytes: 1024,
      verifyTls: true,
      followRedirects: false,
    };
    return fetchHttp(
      policy === undefined ? options : { ...options, targetPolicy: policy },
      AbortSignal.timeout(2_000),
    );
  };

  /**
   * The guard's refusal message if it refused, and `undefined` otherwise — whether the request
   * then failed on its own or succeeded.
   *
   * **Written this way because `assert.rejects` cannot express what these cases assert.** Three
   * of them check that the guard did *not* fire, and did it by requiring the request to fail for
   * some other reason. That holds a negative hostage to an unrelated positive: on a machine where
   * the address happens to answer, the call resolves, nothing rejects, and the test reports the
   * guard as broken when the guard was right.
   *
   * It is not hypothetical. `refuses nothing at all under \`none\`` failed on every CI run with
   * `Missing expected rejection` in 5.5 ms — because GitHub's runners are Azure VMs, where
   * 169.254.169.254 is the live instance-metadata service and answers immediately.
   */
  const refusalFrom = async (call: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await call();
      return undefined;
    } catch (error) {
      const message = (error as Error).message;
      return /refusing to request/.test(message) ? message : undefined;
    }
  };

  it('refuses the cloud metadata address by default', async () => {
    // 169.254.169.254 hands out IAM credentials to anything that asks, and a monitoring server
    // with an HTTP sensor is exactly the thing that can be persuaded to ask.
    await assert.rejects(() => request('169.254.169.254'), /refusing to request/);
  });

  it('says which address and why, so an operator can act on it', async () => {
    await assert.rejects(
      () => request('169.254.169.254'),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /169\.254\.169\.254/);
        assert.match(message, /link-local/);
        assert.match(message, /instance-metadata/);
        return true;
      },
    );
  });

  it('refuses the IPv6 link-local range too', async () => {
    // An allowlist that only knew the famous IPv4 address would be a guard in name: some
    // providers answer on fe80::/10.
    await assert.rejects(() => request('fe80::1'), /refusing to request/);
  });

  it('allows a private address, because that is the job', async () => {
    // Whether the connection then succeeds is not this test's business — nothing is listening
    // here, but a machine that had something listening must not turn this red.
    assert.equal(await refusalFrom(() => request('10.255.255.1')), undefined);
  });

  it('refuses a private address under the stricter policy', async () => {
    await assert.rejects(() => request('10.255.255.1', 'private'), /refusing to request/);
  });

  it('refuses nothing at all under `none`', async () => {
    // **Not the metadata address, deliberately.** Under `none` the guard steps aside, so naming
    // 169.254.169.254 here means the test really does send a request to the instance-metadata
    // service on any cloud machine that runs it — the exact request this whole file exists to
    // prevent, issued on purpose. 169.254.1.1 is link-local too, so it makes the same point:
    // refused by default, and reached under `none`.
    assert.notEqual(await refusalFrom(() => request('169.254.1.1')), undefined);
    assert.equal(await refusalFrom(() => request('169.254.1.1', 'none')), undefined);
  });

  it('does not read a target that answers as a refusal', async () => {
    // **The regression guard for the defect the helper above exists for.** Every other case here
    // reaches something unreachable, so a test that confused "no refusal" with "some failure"
    // passed on a developer machine for as long as this file existed. This one answers 200, which
    // is the case CI met and nothing local did.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    after(() => {
      server.close();
    });
    const { port } = server.address() as AddressInfo;

    assert.equal(await refusalFrom(() => request('127.0.0.1', undefined, port)), undefined);
    assert.equal(await refusalFrom(() => request('127.0.0.1', 'none', port)), undefined);
  });

  it('leaves a name that will not resolve to the request’s own error', async () => {
    // Not this guard's business. Reporting it here would replace a diagnosis the caller already
    // produces with a worse one.
    assert.equal(await refusalFrom(() => request('no-such-host.invalid')), undefined);
  });
});
