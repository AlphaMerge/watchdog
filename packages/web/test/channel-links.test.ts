import { describe, expect, it } from 'vitest';
import { channelLinkFor } from '../src/routes/detail/channel-links';

/**
 * The way from a Core Health count to the list it is counting (`U-21`, `U-63`), in a module of
 * its own since `U-70`: one of the lists is not of credentials.
 */
describe('the way from Core Health to the list', () => {
  it('links that channel on that type, and nothing else', () => {
    expect(channelLinkFor('ms.core.health', 'credentialsUnbounded')).toEqual({
      to: '/credentials/unbounded',
      label: 'Which sets',
    });
    // And the sensors whose stored parameters their type now refuses (`U-63`).
    expect(channelLinkFor('ms.core.health', 'sensorsWithInvalidParams')).toEqual({
      to: '/tree?invalidParams=true',
      label: 'Which sensors',
    });
    expect(channelLinkFor('ms.core.health', 'credentialsToReenter')).toBeNull();
    expect(channelLinkFor('script.custom', 'credentialsUnbounded')).toBeNull();
    expect(channelLinkFor('script.custom', 'sensorsWithInvalidParams')).toBeNull();
    expect(channelLinkFor(undefined, 'credentialsUnbounded')).toBeNull();
  });
});
