import { INVALID_PARAMS_PATH } from '../../tree/invalid-params';
import { UNBOUNDED_PATH } from './credentials-model';

/**
 * The way from a channel's number to the list it is counting (`U-21`, `U-63`), apart from the
 * channel table that draws the link and from any one list's model: the lists are not all of
 * credentials (`U-70`).
 */

/**
 * A page a channel's number is counting, when there is one.
 *
 * Core Health's **Credential sets without targets** is a count with nothing beside it to say
 * which sets, and the list is where that is answered; so is **Sensors with invalid parameters**
 * (`U-63`), whose list is the tree filtered to them. Keyed by sensor type as well as channel, so
 * a channel that only shares the key on another type is not given a link to a list it is not
 * counting.
 */
export function channelLinkFor(
  sensorType: string | undefined,
  channelKey: string,
): { to: string; label: string } | null {
  if (sensorType !== 'ms.core.health') return null;
  if (channelKey === 'credentialsUnbounded') return { to: UNBOUNDED_PATH, label: 'Which sets' };
  if (channelKey === 'sensorsWithInvalidParams') {
    return { to: INVALID_PARAMS_PATH, label: 'Which sensors' };
  }
  return null;
}
