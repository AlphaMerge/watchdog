import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { socketBacklog } from '../src/api/routes/stream.js';

/**
 * How far behind a stream subscriber is, discounting its own snapshot (`P-60`, `P-66`).
 *
 * Pure, and in its own file rather than beside the broadcaster's tests, because those need a
 * database and this needs to run everywhere. That separation is the point: `P-60` shipped with
 * its only coverage of this being an assertion in a database-gated test that compared the
 * *client* socket's `bufferedAmount` against the *server's* reported backlog — both 0 at the
 * moment it ran, so it read `0 === 0` and would have passed against any implementation at all.
 */

/** A socket whose buffer the test moves by hand, which no real one will do on demand. */
function fakeSocket(): { bufferedAmount: number } {
  return { bufferedAmount: 0 };
}

describe('the backlog a stream subscriber reports', () => {
  it('reports the raw buffer when nothing has been forgiven', () => {
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    socket.bufferedAmount = 4_096;
    assert.equal(backlog.report(), 4_096);
  });

  it('forgives a snapshot that is still going out', () => {
    // The case `P-66` was. A snapshot of 20,000 sensors is megabytes down the same socket the
    // cut-off measures, so counting it made the first state event detach a client that was
    // keeping up perfectly — which sent it back to resubscribe and be detached again.
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    socket.bufferedAmount = 4_000_000;
    backlog.allow(4_000_000);
    assert.equal(backlog.report(), 0, 'its own snapshot is not the client falling behind');
  });

  it('shrinks the allowance as the snapshot drains, and never lets it grow back', () => {
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    socket.bufferedAmount = 4_000_000;
    backlog.allow(4_000_000);
    assert.equal(backlog.report(), 0);

    socket.bufferedAmount = 1_000_000;
    assert.equal(backlog.report(), 0, 'still the same snapshot, half of it delivered');

    // The reading above clamped the allowance to what was left. Bytes arriving now are events,
    // and they are counted in full — the forgiveness does not refill.
    socket.bufferedAmount = 1_500_000;
    assert.equal(backlog.report(), 500_000);
  });

  it('arms at full strength once the snapshot has gone', () => {
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    socket.bufferedAmount = 2_000_000;
    backlog.allow(2_000_000);
    socket.bufferedAmount = 0;
    assert.equal(backlog.report(), 0, 'drained');

    socket.bufferedAmount = 3_000_000;
    assert.equal(backlog.report(), 3_000_000, 'and this is the client, not the snapshot');
  });

  it('counts events stacked on top of a snapshot that has not moved', () => {
    // A client that stalls *during* its snapshot. The snapshot stays forgiven — we chose to send
    // it — but everything piled on behind it is the backlog the cut-off exists for.
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    socket.bufferedAmount = 4_000_000;
    backlog.allow(4_000_000);
    socket.bufferedAmount = 4_000_000 + 2_000_000;
    assert.equal(backlog.report(), 2_000_000);
  });

  it('forgives a second snapshot when a client resubscribes', () => {
    // Resubscribing is how a client resyncs, and it takes a fresh snapshot every time. Each one
    // is forgiven its own bytes; the clamp is what stops the allowance accumulating past what is
    // really queued.
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    socket.bufferedAmount = 1_000_000;
    backlog.allow(1_000_000);
    socket.bufferedAmount = 0;
    assert.equal(backlog.report(), 0);

    socket.bufferedAmount = 1_000_000;
    backlog.allow(1_000_000);
    assert.equal(backlog.report(), 0, 'the second snapshot too');

    socket.bufferedAmount = 0;
    assert.equal(backlog.report(), 0);
    socket.bufferedAmount = 900_000;
    assert.equal(backlog.report(), 900_000, 'and no allowance survives either of them');
  });
});
