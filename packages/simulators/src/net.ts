import { createSocket, type Socket as UdpSocket } from 'node:dgram';
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

/**
 * A UDP socket bound to `address:port` (0 for an ephemeral port). `exclusive` so a worker
 * thread's socket is its own, not shared through the primary as cluster workers share them, and
 * `ipv6Only` on IPv6, so `::1` never stands for an IPv4 address too.
 */
export function bindUdp(type: 'udp4' | 'udp6', address: string, port: number): Promise<UdpSocket> {
  const socket = createSocket({ type, ipv6Only: type === 'udp6' });
  return new Promise((resolve, reject) => {
    socket.once('error', (error) => {
      try {
        socket.close();
      } catch {
        // Already closed by the failed bind.
      }
      reject(error);
    });
    socket.bind({ port, address, exclusive: true }, () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
}

/** Closes a UDP socket and waits for it, tolerating one that is closed already. */
export function closeUdp(socket: UdpSocket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * Opens a socket whose ephemeral port is not one of `avoid` (`P-432` S5, F4): a simulated DNS
 * server that is dead keeps its port number with nothing bound to it, and a client the kernel
 * handed that number would take the queries meant to get ECONNREFUSED, and later stop the
 * server binding its port again. A socket that drew an avoided port is held until a good one is
 * open, so the next draw cannot repeat it, then closed.
 */
export async function avoidingPorts<T>(
  open: () => Promise<T>,
  portOf: (socket: T) => number,
  close: (socket: T) => Promise<void>,
  avoid: Iterable<number>,
  tries = 32,
): Promise<T> {
  const avoided = new Set(avoid);
  const drawn: T[] = [];
  try {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const socket = await open();
      if (!avoided.has(portOf(socket))) return socket;
      drawn.push(socket);
    }
    throw new Error(
      `no ephemeral port outside ${[...avoided].join(', ')} in ${String(tries)} tries`,
    );
  } finally {
    await Promise.all(drawn.map(close));
  }
}
