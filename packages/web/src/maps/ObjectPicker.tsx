import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api/client';
import type { ObjectPage } from '../api/types';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import type { WidgetKind } from './canvas';

/**
 * Which object a widget draws (`G-03`).
 *
 * **A search, not a dropdown.** The v1 target is 5,000 sensors and a `<select>` holding the first
 * two hundred of them is a control that quietly cannot reach most of the estate — the same
 * mistake as a tree that only renders what fits. `?q=` is the core's own search, so the designer
 * asks the question the same way the tree does.
 *
 * **The kind filter follows the widget.** A status tile and a channel table draw one sensor; a
 * sensor list draws everything *below* something, which is a probe, a group or a device. Offering
 * a sensor there would make a list of the one sensor it was pointed at.
 */

const DEBOUNCE_MS = 200;

const KIND_QUERY: Readonly<Record<WidgetKind, string>> = {
  status: 'kind=sensor',
  table: 'kind=sensor',
  graph: 'kind=sensor',
  'sensor-list': 'kind=probe&kind=group&kind=device',
  // Never asked: a custom HTML tile draws no object, so the picker is not rendered for it.
  html: '',
};

export interface Picked {
  readonly id: number;
  readonly name: string;
}

export function ObjectPicker({
  kind,
  value,
  onPick,
}: {
  readonly kind: WidgetKind;
  readonly value: Picked | null;
  readonly onPick: (picked: Picked | null) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [deferred, setDeferred] = useState('');

  // One request per pause, not one per keystroke. `useApi` aborts the one in flight when the
  // path changes, so a fast typist leaves at most one live request behind either way — this is
  // about not asking the core five questions to answer one.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDeferred(query);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  const trimmed = deferred.trim();
  const path =
    trimmed.length < 2
      ? null
      : `/objects?${KIND_QUERY[kind]}&q=${encodeURIComponent(trimmed)}&limit=20&sort=name`;
  const found = useApi<ObjectPage>(path);

  const options = useMemo<ComboboxOption[]>(() => {
    if (found.status !== 'ready') return [];
    return found.data.items.map((item) => ({
      value: item.name,
      badge: item.kind,
      detail: `#${String(item.id)}`,
    }));
  }, [found]);

  const byName = useMemo(() => {
    if (found.status !== 'ready') return new Map<string, number>();
    return new Map(found.data.items.map((item) => [item.name, item.id]));
  }, [found]);

  return (
    <div className="min-w-56">
      <Combobox
        id="map-widget-object"
        label={kind === 'sensor-list' ? 'Group, device or probe' : 'Sensor'}
        placeholder={value === null ? 'Search…' : value.name}
        value={query}
        onChange={(next) => {
          setQuery(next);
          // Typing after a pick means the pick is stale: the Add button must not quietly use the
          // object somebody has just started typing over.
          if (value !== null) onPick(null);
        }}
        onPick={(option) => {
          const id = byName.get(option.value);
          if (id === undefined) return;
          setQuery(option.value);
          onPick({ id, name: option.value });
        }}
        options={options}
      />
    </div>
  );
}
