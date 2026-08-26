import type { Queryable } from '../db/pool.js';
import { OBJECT_LOCATION } from '../settings/registry.js';
import type { SensorState } from '../state/tables.js';
import type { MessageContext } from './placeholders.js';

/** One queued notification, as much of it as building a message needs. */
export interface PendingNotification {
  readonly id: number;
  readonly sensorId: number;
  readonly at: Date;
  readonly state: SensorState;
  readonly message: string;
  /** Set on a threshold notification (`N-03`) — the value that breached. */
  readonly observed: number | null;
}

/** Just enough of `InheritanceResolver` to resolve one key for a batch of sensors. */
export interface LocationSource {
  resolveForObjects(
    objectIds: readonly number[],
    key: string,
  ): Promise<Map<number, { value: unknown }>>;
}

export interface MessageContextLoaderOptions {
  /** Where `%location` comes from. Absent renders it empty rather than wrong. */
  settings?: LocationSource;
  publicUrl?: string;
  siteName?: string;
  /**
   * How far back a channel reading may be and still be `%lastvalue`.
   *
   * The same bound and the same reasoning as `N-03`'s: a value from yesterday is not what the
   * sensor reads now, and bounding it keeps the lateral inside the newest chunk or two.
   */
  valueLookbackMs?: number;
}

const DEFAULT_VALUE_LOOKBACK_MS = 6 * 60 * 60 * 1_000;

interface AncestryRow {
  sensor_id: string;
  sensor_name: string;
  device_name: string | null;
  group_name: string | null;
  probe_name: string | null;
  host: string | null;
  comments: string;
  tags: string[];
  priority: number;
  since: Date;
  previous_state: SensorState | null;
  last_value: number | null;
}

/**
 * What builds a `MessageContext` for a batch of queued notifications (`N-06`).
 *
 * **Batched, in three queries, however many notifications there are.** `N-11` assembles digests
 * of up to twenty-five notifications and an outage can queue hundreds at once; a loader that
 * asked per notification would make the message-building step the slowest thing in delivery, and
 * would do it at exactly the moment the system is busiest.
 *
 * The ancestry is one recursive walk rather than four joins, because "the nearest device above
 * this sensor" is not a fixed depth: `CAPABILITIES.MD §1` allows groups inside groups, so a
 * sensor may sit four levels below its probe or ten.
 */
export class MessageContextLoader {
  readonly #settings: LocationSource | undefined;
  readonly #publicUrl: string;
  readonly #siteName: string;
  readonly #valueLookbackMs: number;

  constructor(options: MessageContextLoaderOptions = {}) {
    this.#settings = options.settings;
    this.#publicUrl = options.publicUrl ?? '';
    this.#siteName = options.siteName ?? 'MonitoringSystem';
    this.#valueLookbackMs = options.valueLookbackMs ?? DEFAULT_VALUE_LOOKBACK_MS;
  }

  async loadFor(
    q: Queryable,
    notifications: readonly PendingNotification[],
    now: Date,
  ): Promise<Map<number, MessageContext>> {
    const out = new Map<number, MessageContext>();
    if (notifications.length === 0) return out;

    const sensorIds = [...new Set(notifications.map((notification) => notification.sensorId))];
    const [facts, locations] = await Promise.all([
      this.#factsOf(q, sensorIds, now),
      this.#locationsOf(sensorIds),
    ]);

    for (const notification of notifications) {
      const row = facts.get(notification.sensorId);
      // A sensor deleted between the notification being queued and this running. The message is
      // still owed — somebody was told an outage started — so it is built from what the request
      // itself carries rather than dropped.
      out.set(notification.id, {
        sensorId: notification.sensorId,
        sensorName: row?.sensorName ?? `sensor ${String(notification.sensorId)}`,
        deviceName: row?.deviceName ?? '',
        groupName: row?.groupName ?? '',
        probeName: row?.probeName ?? '',
        host: row?.host ?? '',
        location: locations.get(notification.sensorId) ?? '',
        comments: row?.comments ?? '',
        tags: row?.tags ?? [],
        priority: row?.priority ?? 3,
        state: notification.state,
        previousState: row?.previousState ?? null,
        message: notification.message,
        // The threshold's own value when there is one: it is the number the notification is
        // about, frozen when the obligation fell due, and the channel has moved on since.
        lastValue: notification.observed ?? row?.lastValue ?? null,
        at: notification.at,
        since: row?.since ?? notification.at,
        publicUrl: this.#publicUrl,
        siteName: this.#siteName,
      });
    }
    return out;
  }

  /**
   * Names, ancestry, tags, priority and the last reading, for a batch of sensors.
   *
   * One statement. The ancestry walk climbs from each sensor to the root collecting the nearest
   * object of each kind; the two laterals read the newest state transition and the newest sample
   * of the primary channel.
   */
  async #factsOf(
    q: Queryable,
    sensorIds: readonly number[],
    now: Date,
  ): Promise<
    Map<
      number,
      {
        sensorName: string;
        deviceName: string;
        groupName: string;
        probeName: string;
        host: string;
        comments: string;
        tags: string[];
        priority: number;
        since: Date;
        previousState: SensorState | null;
        lastValue: number | null;
      }
    >
  > {
    const rows = await q.query<AncestryRow>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS sensor_id, o.id, o.parent_id, o.kind, o.name, o.tags, 0 AS depth
        FROM object o
        WHERE o.id = ANY($1::bigint[])

        UNION ALL

        SELECT chain.sensor_id, p.id, p.parent_id, p.kind, p.name, p.tags, chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
      ),
      ancestry AS (
        SELECT
          sensor_id,
          -- The *nearest* of each kind, which is what a message means by "the device". A
          -- sensor four groups deep has four candidate groups and one that matters.
          (ARRAY_AGG(name ORDER BY depth) FILTER (WHERE kind = 'device'))[1] AS device_name,
          (ARRAY_AGG(name ORDER BY depth) FILTER (WHERE kind = 'group'))[1]  AS group_name,
          (ARRAY_AGG(name ORDER BY depth) FILTER (WHERE kind = 'probe'))[1]  AS probe_name,
          -- The id too, because the address is not on the object row: a device's host lives in
          -- device_config, which is what makes %host a join rather than a column.
          (ARRAY_AGG(id ORDER BY depth) FILTER (WHERE kind = 'device'))[1]   AS device_id
        FROM chain
        GROUP BY sensor_id
      )
      SELECT
        s.id::text        AS sensor_id,
        s.name            AS sensor_name,
        a.device_name,
        a.group_name,
        a.probe_name,
        dc.host,
        s.comments,
        inherited_tags.tags,
        s.priority,
        r.since,
        last_state.previous_state,
        last_sample.value AS last_value
      FROM object s
      JOIN ancestry a ON a.sensor_id = s.id
      LEFT JOIN device_config dc ON dc.object_id = a.device_id
      LEFT JOIN sensor_runtime r ON r.object_id = s.id
      -- Own tags *and* inherited ones. CAPABILITIES.MD §1 makes "tags + inherited parent tags"
      -- a v1 capability, and the object filter already resolves them that way -- a message that
      -- showed only the sensor's own would disagree with the search that found it. Sorted, so
      -- the same sensor renders the same list every time.
      LEFT JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT tag ORDER BY tag), '{}'::text[]) AS tags
        FROM chain c2, unnest(c2.tags) AS tag
        WHERE c2.sensor_id = s.id
      ) AS inherited_tags ON true
      LEFT JOIN LATERAL (
        SELECT h.previous_state FROM sensor_state h
        WHERE h.sensor_id = s.id
        ORDER BY h.time DESC
        LIMIT 1
      ) AS last_state ON true
      LEFT JOIN LATERAL (
        SELECT sm.value
        FROM channel c
        JOIN sample sm ON sm.channel_id = c.id
        WHERE c.sensor_id = s.id AND c.is_primary AND sm.time > $2 AND sm.time <= $3
        ORDER BY sm.time DESC
        LIMIT 1
      ) AS last_sample ON true
      WHERE s.id = ANY($1::bigint[])
      `,
      [sensorIds, new Date(now.getTime() - this.#valueLookbackMs), now],
    );

    return new Map(
      rows.map((row) => [
        Number(row.sensor_id),
        {
          sensorName: row.sensor_name,
          deviceName: row.device_name ?? '',
          groupName: row.group_name ?? '',
          probeName: row.probe_name ?? '',
          host: row.host ?? '',
          comments: row.comments,
          tags: row.tags,
          priority: row.priority,
          since: row.since,
          previousState: row.previous_state,
          lastValue: row.last_value,
        },
      ]),
    );
  }

  /** `%location`, resolved through the one resolver rather than a second parent-walk. */
  async #locationsOf(sensorIds: readonly number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (this.#settings === undefined) return out;
    const resolved = await this.#settings.resolveForObjects(sensorIds, OBJECT_LOCATION.key);
    for (const [sensorId, entry] of resolved) {
      if (typeof entry.value === 'string' && entry.value !== '') out.set(sensorId, entry.value);
    }
    return out;
  }
}
