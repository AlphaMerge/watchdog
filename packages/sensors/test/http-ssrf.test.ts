import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
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
  const request = (host: string, policy?: TargetPolicy) => {
    // Built as a typed value rather than spread in: under `exactOptionalPropertyTypes` a
    // conditional spread widens the property to include `undefined`, which the option's own
    // type deliberately does not accept.
    const options: HttpRequestOptions = {
      host,
      port: 80,
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
    // The request itself will fail — nothing is listening — but it must fail as a *connection*
    // rather than as a refusal, which is what distinguishes the guard from a broken sensor.
    await assert.rejects(
      () => request('10.255.255.1'),
      (error: unknown) => {
        assert.equal(/refusing to request/.test((error as Error).message), false);
        return true;
      },
    );
  });

  it('refuses a private address under the stricter policy', async () => {
    await assert.rejects(() => request('10.255.255.1', 'private'), /refusing to request/);
  });

  it('refuses nothing at all under `none`', async () => {
    await assert.rejects(
      () => request('169.254.169.254', 'none'),
      (error: unknown) => {
        assert.equal(/refusing to request/.test((error as Error).message), false);
        return true;
      },
    );
  });

  it('leaves a name that will not resolve to the request’s own error', async () => {
    // Not this guard's business. Reporting it here would replace a diagnosis the caller already
    // produces with a worse one.
    await assert.rejects(
      () => request('no-such-host.invalid'),
      (error: unknown) => {
        assert.equal(/refusing to request/.test((error as Error).message), false);
        return true;
      },
    );
  });
});
