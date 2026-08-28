import type { Server as NetServer } from 'node:net';

/**
 * Binds a server to an ephemeral port on the loopback interface and reports which one.
 *
 * **Port 0 rather than a chosen number, everywhere.** A harness that picks 8080 fails on the one
 * machine where something else has it, and fails *intermittently* when two test files run at
 * once — which is the worst kind of failure to debug, because the test that breaks is not the
 * test that is wrong. Every simulator here takes its port from the kernel.
 *
 * Loopback rather than every interface: a test fixture that answers on the network is a service
 * somebody's laptop is running without knowing it.
 */
export async function listen(server: NetServer, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind to a TCP port');
  }
  return address.port;
}

/** Closes a server and waits for it, tolerating one that was never listening. */
export async function close(server: NetServer | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
