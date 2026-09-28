import { useId } from 'react';
import type { DeviceTemplateSummary } from '../api/types';

/**
 * The controls the discovery page's two forms share (`D-10`, `D-11`): starting a run, and
 * writing a rule that starts them. One copy, so the two forms cannot drift apart on the
 * accessibility details below.
 */

/*
 * `border-control`, and no `focus:outline-none` — this was the one U-11 missed.
 *
 * It carried `border-border focus:border-accent focus:outline-none`, which is both halves of the
 * defect that pass fixed everywhere else: the divider grey on the edge of an input is 1.30:1
 * against the surface, under 1.4.11's 3:1 for a control boundary, and removing the outline in
 * favour of a border colour leaves nothing at all in forced-colors mode, where the border is
 * repainted by the system. The one `:focus-visible` rule in `index.css` is the indicator; a
 * control's job is to not take it away.
 */
export const INPUT = 'w-full border border-control bg-surface px-2 py-1 text-sm text-text';
export const SELECT = INPUT;

/**
 * A labelled control with a hint under it.
 *
 * **The hint sits outside the `<label>`, and that is the whole point of this component.** Wrapping
 * both in one label folds the hint into the control's accessible *name*, so a screen reader
 * announces "Range 10.0.0.0/24, 10.0.0.1-10.0.0.50, or a single address, IPv4 only" every time
 * focus lands — the name is supposed to be "Range" and the rest is a description. Found by
 * reading the page's accessibility tree rather than by looking at it, which is the only way this
 * kind of defect is ever found.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (described: string | undefined) => React.ReactNode;
}): React.JSX.Element {
  const hintId = `${useId()}-hint`;
  return (
    <div className="block">
      <label className="block">
        <span className="text-sm font-medium text-text">{label}</span>
        {children(hint === undefined ? undefined : hintId)}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="mt-1 text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TemplatePicker({
  templates,
  chosen,
  onChange,
}: {
  templates: DeviceTemplateSummary[];
  chosen: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-text">Templates</legend>
      <p className="mt-1 text-xs text-text-muted">
        None ticked means all of them, which is what you want unless you are deliberately narrowing.
        A run filtered to templates that match nothing creates the device and no sensors.
      </p>
      <div className="mt-2 max-h-40 space-y-1 overflow-y-auto border border-border p-2">
        {templates.length === 0 && <p className="text-sm text-text-muted">No templates loaded.</p>}
        {templates.map((template) => (
          <label key={template.id} className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={chosen.includes(template.id)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...chosen, template.id]
                    : chosen.filter((id) => id !== template.id),
                );
              }}
            />
            <span className="truncate">{template.name}</span>
            <span className="ml-auto shrink-0 text-xs text-text-muted">
              {template.sensorCount} {template.sensorCount === 1 ? 'sensor' : 'sensors'}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
