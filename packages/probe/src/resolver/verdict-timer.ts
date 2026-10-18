/**
 * When a verdict about a peer's silence may be taken (`P-432`, D5).
 *
 * A timer fires in the timers phase, and a reply already sitting in a socket is read in the poll
 * phase after it. So a timer that fires late, after the probe's main thread was blocked, would
 * judge "no answer" while the answer waits unread a few microseconds away. That is how a stall
 * fakes evidence: P-243's 15 s stall would have made a working peer look dead.
 *
 * **`afterPolls` runs its function after two `setImmediate` hops.** A check phase always follows
 * a poll phase, and two hops from any phase cross at least one poll phase, in libuv's order before
 * 1.45 and since. So everything readable when the timer fired has been read, and its handlers
 * run, before the verdict. Every verdict the gate takes on a timer goes through here: the lookup
 * helper's liveness ticks, its start bound and its rejoin window, and the child's own stuck clock.
 */
export function afterPolls(fn: () => void): void {
  setImmediate(() => {
    setImmediate(fn);
  });
}
