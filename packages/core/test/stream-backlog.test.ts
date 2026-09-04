import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { socketBacklog } from '../src/api/routes/stream.js';

/**
 * How much of what a stream subscriber's socket holds is *events* (`P-60`, `P-66`, `P-70`).
 *
 * Pure, and in its own file rather than beside the broadcaster's tests, because those need a
 * database and this needs to run everywhere. That separation is the point: `P-60` shipped with
 * its only coverage of this being an assertion in a database-gated test that compared the
 * *client* socket's `bufferedAmount` against the *server's* reported backlog — both 0 at the
 * moment it ran, so it read `0 === 0` and would have passed against any implementation at all.
 *
 * The model these pin comes from the socket being FIFO: the snapshot is queued first, so it
 * leaves first, and `min(bufferedAmount, eventBytesSinceSnapshot)` is the event backlog in both
 * the "snapshot still going out" and the "snapshot gone" cases. Notably `bufferedAmount` does
 * **not** decay while a write is in flight — `ws` reports `_writableState.length`, which Node
 * clears only when the whole write completes — which is what `P-66`'s first attempt assumed and
 * got wrong.
 */

/** A socket whose buffer the test moves by hand, which no real one will do on demand. */
function fakeSocket(): { bufferedAmount: number } {
  return { bufferedAmount: 0 };
}

describe('the backlog a stream subscriber reports', () => {
  it('reports nothing before anything has been sent', () => {
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    socket.bufferedAmount = 4_096;
    assert.equal(backlog.report(), 0, 'bytes nobody has accounted for are not this client’s fault');
  });

  it('does not count the snapshot it just sent', () => {
    // The case `P-66` was. A snapshot of 20,000 sensors is megabytes down the same socket the
    // cut-off measures, so counting it detached a client that was keeping up perfectly — which
    // sent it back to resubscribe and be detached again.
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    backlog.snapshot();
    socket.bufferedAmount = 4_000_000;
    assert.equal(backlog.report(), 0);
  });

  it('counts events queued behind a snapshot that has not moved at all', () => {
    // **The case `P-66`'s first fix got wrong.** `bufferedAmount` does not decay as a snapshot
    // drains, so an allowance clamped to it landed on the events instead and forgave them.
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    backlog.snapshot();
    socket.bufferedAmount = 4_000_000;

    socket.bufferedAmount += 300;
    backlog.wrote(300);
    assert.equal(backlog.report(), 300);

    socket.bufferedAmount += 700;
    backlog.wrote(700);
    assert.equal(backlog.report(), 1_000, 'every event byte, and none of the snapshot');
  });

  it('keeps counting them when the snapshot completes in one step', () => {
    // A write completes all at once, so the buffer drops from snapshot-plus-events to events.
    // The events must survive that transition — forgiving them there is what made a client that
    // stalled mid-snapshot permanently uncuttable.
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    backlog.snapshot();
    socket.bufferedAmount = 4_000_000;
    backlog.wrote(50_000);
    socket.bufferedAmount += 50_000;
    assert.equal(backlog.report(), 50_000);

    socket.bufferedAmount = 50_000; // the snapshot's write finished; the events did not.
    assert.equal(backlog.report(), 50_000, 'still behind by every event it has not read');
  });

  it('follows the buffer down as the client actually reads', () => {
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    backlog.snapshot();
    backlog.wrote(90_000);
    socket.bufferedAmount = 90_000;
    assert.equal(backlog.report(), 90_000);

    socket.bufferedAmount = 20_000;
    assert.equal(backlog.report(), 20_000, 'read most of it');

    socket.bufferedAmount = 0;
    assert.equal(backlog.report(), 0, 'and caught up');
  });

  it('starts the accounting again at every resubscribe', () => {
    // Resubscribing takes a fresh snapshot, which supersedes everything queued before it. Without
    // the reset the old event total would keep an idle client permanently over the limit.
    const socket = fakeSocket();
    const backlog = socketBacklog(socket);
    backlog.snapshot();
    backlog.wrote(900_000);
    socket.bufferedAmount = 900_000;
    assert.equal(backlog.report(), 900_000);

    backlog.snapshot();
    socket.bufferedAmount = 3_000_000;
    assert.equal(backlog.report(), 0, 'the new snapshot is not a backlog');

    backlog.wrote(400);
    socket.bufferedAmount += 400;
    assert.equal(backlog.report(), 400);
  });
});
