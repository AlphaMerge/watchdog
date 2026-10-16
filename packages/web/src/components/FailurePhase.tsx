import type { CheckFailure } from '../api/types';
import { failureWords } from './failure-words';

/**
 * Where a check failed (`P-285`): "Failed while connecting to 192.0.2.7:22".
 *
 * **Visible text, never a `title`**: a tooltip is reached by neither a keyboard nor a touch (WCAG
 * 1.3.1, 2.1.1), and this is the part of a failure an operator acts on. No colour of its own,
 * beside the cause and the message it sits with (1.4.1). The host in the monospace the device's
 * Host field uses, since it is one.
 */
export function FailurePhase({ failure }: { failure: CheckFailure }): React.JSX.Element {
  const { lead, target } = failureWords(failure);
  return (
    <span>
      {lead}
      {target !== null && (
        <>
          {' '}
          <span className="font-mono">{target}</span>
        </>
      )}
    </span>
  );
}
