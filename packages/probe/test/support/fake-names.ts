import { systemResolve, type ResolvedAddress, type ResolveHost } from '@ms/sensors';

/**
 * A resolver that answers by the name it is asked (`A-66`, `P-426`): what `lookup-registry.ts`'s
 * workers resolve with when their pool does not serve lookups, and what a test hands the probe's
 * `NameResolver` as `getaddrinfo` when it does.
 *
 * | Name | Answer |
 * | --- | --- |
 * | `answers*.test` | 192.0.2.10, at once |
 * | `fails*.test` | `ENOTFOUND`, at once |
 * | `again*.test` | `EAI_AGAIN`, at once |
 * | `hangs*.test` | never |
 * | `late-<ms>*.test` | 192.0.2.10 after `<ms>` |
 * | `sys-*.test` | `getaddrinfo` for `localhost`: the system resolver, from the hosts file |
 */

export const FAKE_ANSWER: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];

function failed(host: string, code: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
}

export const fakeResolve: ResolveHost = (host, family) => {
  const name = host.toLowerCase();
  if (name.startsWith('sys-')) return systemResolve('localhost', family);
  if (name.startsWith('answers')) return Promise.resolve(FAKE_ANSWER);
  if (name.startsWith('fails')) return Promise.reject(failed(host, 'ENOTFOUND'));
  if (name.startsWith('again')) return Promise.reject(failed(host, 'EAI_AGAIN'));
  if (name.startsWith('hangs')) return new Promise(() => undefined);
  const late = /^late-(\d+)/.exec(name);
  if (late !== null) {
    return new Promise((answered) => {
      setTimeout(() => {
        answered(FAKE_ANSWER);
      }, Number(late[1]));
    });
  }
  return Promise.reject(failed(host, 'ENOTFOUND'));
};
