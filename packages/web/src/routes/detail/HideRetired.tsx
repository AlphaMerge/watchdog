/**
 * "Hide retired channels", wherever the sensor page lists channels (`U-38`, `U-55`).
 *
 * **One control, one choice for the page.** The channel table and the History tab each show it,
 * and both read and write the page's `?retired=hide`, so the box says the same thing on either
 * tab and a link sent from one opens the other the same way. Held by the page and not here: the
 * table is unmounted whenever a poll of its values fails, and a choice held inside it went with
 * it.
 *
 * Only where there is something to hide — a control that changes nothing is noise — so a caller
 * renders it when `count` is above zero. The count is said in text when they are hidden, so a
 * shorter list is never read as the sensor's whole; the region is present before it changes, so
 * ticking the box announces it.
 */
export function HideRetired({
  count,
  hidden,
  onChange,
  className = '',
}: {
  /** How many retired channels the list would show. */
  count: number;
  hidden: boolean;
  onChange: (hide: boolean) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`.trim()}>
      <label className="flex min-h-6 items-center gap-1.5 text-sm text-text-muted">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        Hide retired channels
      </label>
      <p className="text-xs text-text-muted" role="status">
        {!hidden
          ? ''
          : count === 1
            ? '1 retired channel hidden.'
            : `${String(count)} retired channels hidden.`}
      </p>
    </div>
  );
}
