import { savepoint, uniqueViolation, type Queryable } from './pool.js';

/**
 * Every unique constraint and unique index in the schema, and what a route that breaks it is told
 * (`P-391`).
 *
 * A 23505 nothing answers reaches `toHttpError`, which can say only that something must be
 * unique: it does not know what is in the way, nor whether the caller may be told. `P-386` found
 * `probe_config_gid_unique` answering that way, and the sweep that followed found a template's
 * name, a schedule's name, a group renamed onto another's and a probe gid given through the
 * object routes doing the same. So each rule is written down here, once:
 *
 * - **`refused`**: a route can break it, and the service answers first, with the code given here
 *   and a sentence naming what is in the way (to a caller allowed to see it). `refusingTaken`
 *   below is the usual shape: a check before the write, and the constraint as the backstop for a
 *   row another transaction commits between the two.
 * - **`unreachable`**: no route can break it, and why: no route writes the table, the key is
 *   generated, an `ON CONFLICT` absorbs it, or a lock serialises the writers.
 *
 * `unique-constraints.test.ts` reads the catalogue of a database migrated to the newest schema
 * and fails for an index that is not here, and for an entry that is no longer there. A migration
 * that adds a unique rule therefore says, here, what a caller who breaks it hears.
 */
export type UniqueRule =
  { readonly refused: string; readonly by: string } | { readonly unreachable: string };

export const UNIQUE_CONSTRAINTS = {
  // ── the object tree ──────────────────────────────────────────────────────────────────────
  object_pkey: { unreachable: 'generated; a clone draws its ids from the same sequence' },
  object_single_root: {
    unreachable: 'no route writes a root: the create schemas leave it out and a root is not cloned',
  },
  device_config_pkey: { unreachable: 'written once, for an object id just generated' },
  sensor_config_pkey: { unreachable: 'written once, for an object id just generated' },
  sensor_runtime_pkey: { unreachable: 'written by a trigger, ON CONFLICT DO NOTHING' },
  probe_config_pkey: { unreachable: 'written for a new object id, or ON CONFLICT (object_id)' },
  probe_config_gid_unique: {
    refused: 'OBJECT_GID_TAKEN, PROBE_CONFLICT',
    by: 'ObjectService (create, tree, update) and ProbeRegistry.approve',
  },
  probe_config_one_local: {
    unreachable: 'ProbeRegistry #takeLocal holds an advisory lock and moves or refuses the holder',
  },
  channel_pkey: { unreachable: 'generated' },
  channel_key_unique_per_sensor: {
    unreachable:
      'keys come from the sensor type, whose catalogue refuses one declared twice; ' +
      'ingestion is ON CONFLICT DO NOTHING',
  },
  channel_one_primary_per_sensor: {
    unreachable:
      'the catalogue refuses two primaries, and a redeclaration demotes before it promotes',
  },
  channel_counter_pkey: { unreachable: 'ingestion only, ON CONFLICT DO UPDATE' },
  channel_reap_pkey: { unreachable: 'written by a trigger, ON CONFLICT DO NOTHING' },
  object_setting_pkey: { unreachable: 'ON CONFLICT (object_id, key); a clone writes new ids' },
  object_pause_pkey: { unreachable: 'ON CONFLICT (object_id)' },
  object_access_pkey: { unreachable: 'ON CONFLICT (object_id, group_id); a clone writes new ids' },
  credential_set_pkey: { unreachable: 'generated' },
  credential_set_one_per_kind: { unreachable: 'ON CONFLICT (object_id, kind)' },
  sensor_credential_voucher_pkey: {
    unreachable: 'DISTINCT ON (sensor_id, kind), then ON CONFLICT DO UPDATE',
  },
  credential_voucher_adoption_pkey: { unreachable: 'one row, written by its migration' },
  access_epoch_pkey: { unreachable: 'one row, written by its migration' },
  startup_pass_pkey: { unreachable: 'no route; start-up only, ON CONFLICT (name) DO UPDATE' },

  // ── probes ───────────────────────────────────────────────────────────────────────────────
  probe_registration_pkey: { unreachable: 'the probe endpoint only, ON CONFLICT (gid)' },
  probe_registration_object_idx: {
    refused: 'PROBE_CONFLICT',
    by: 'ProbeRegistry.approve, which locks the object it binds to before it checks',
  },
  probe_protocol_flap_pkey: { unreachable: 'no route; ON CONFLICT DO UPDATE' },
  late_refusal_grace_pkey: { unreachable: 'no route; ON CONFLICT DO UPDATE' },

  // ── measurements and state ───────────────────────────────────────────────────────────────
  sample_channel_time_key: { unreachable: 'the probe endpoint only, ON CONFLICT DO NOTHING' },
  sample_5m_channel_bucket_key: { unreachable: 'the rollup job only, ON CONFLICT' },
  sample_1h_channel_bucket_key: { unreachable: 'the rollup job only, ON CONFLICT' },
  sample_1d_channel_bucket_key: { unreachable: 'the rollup job only, ON CONFLICT' },
  rollup_watermark_pkey: { unreachable: 'the rollup job only, ON CONFLICT (tier)' },
  rollup_backfill_pkey: { unreachable: 'generated' },
  sensor_state_sensor_time_key: { unreachable: 'every writer is ON CONFLICT DO NOTHING' },

  // ── notifications ────────────────────────────────────────────────────────────────────────
  notification_template_pkey: { unreachable: 'generated' },
  notification_template_name_key: {
    refused: 'TEMPLATE_NAME_TAKEN',
    by: 'TemplateService (create, update)',
  },
  notification_trigger_pkey: { unreachable: 'generated' },
  notification_alarm_pkey: { unreachable: 'generated' },
  notification_alarm_sensor_id_trigger_id_key: { unreachable: 'ON CONFLICT DO NOTHING' },
  notification_request_pkey: { unreachable: 'generated' },
  notification_summary_pkey: { unreachable: 'generated' },
  notification_summary_open_idx: {
    unreachable: 'the dispatcher only; it closes the open window under FOR UPDATE first',
  },

  // ── schedules ────────────────────────────────────────────────────────────────────────────
  schedule_pkey: { unreachable: 'generated' },
  schedule_name_key: {
    refused: 'SCHEDULE_NAME_TAKEN',
    by: 'ScheduleService (create, update); seedBuiltIns takes the next free name (P-393)',
  },
  schedule_built_in_id_key: { unreachable: 'start-up seeding only, ON CONFLICT (built_in_id)' },

  // ── accounts and access ──────────────────────────────────────────────────────────────────
  user_account_pkey: { unreachable: 'generated' },
  user_account_login_idx: { refused: 'ACCOUNT_EXISTS', by: 'AccountService.create' },
  user_group_pkey: { unreachable: 'generated' },
  user_group_name_idx: { refused: 'GROUP_EXISTS', by: 'GroupService (create, update)' },
  user_group_default_idx: { unreachable: 'no statement sets is_default; its migration does' },
  user_group_member_pkey: { unreachable: 'ON CONFLICT (group_id, user_id)' },
  user_group_primary_idx: {
    unreachable: 'every writer of a primary group locks the account first, then clears the old one',
  },
  user_session_pkey: { unreachable: 'the hash of a random token' },
  user_totp_pkey: { unreachable: 'ON CONFLICT (user_id)' },
  user_recovery_code_pkey: { unreachable: 'generated' },
  api_token_pkey: { unreachable: 'generated' },
  api_token_name_idx: { refused: 'TOKEN_EXISTS', by: 'TokenService.issue' },
  api_token_token_hash_key: { unreachable: 'the hash of a random token' },
  login_attempt_pkey: { unreachable: 'generated' },
  audit_log_pkey: { unreachable: 'generated' },

  // ── maps, reports, libraries ─────────────────────────────────────────────────────────────
  map_pkey: { unreachable: 'generated' },
  map_access_pkey: { unreachable: 'ON CONFLICT (map_id, group_id)' },
  map_background_pkey: { unreachable: 'ON CONFLICT (map_id)' },
  map_share_pkey: { unreachable: 'generated' },
  map_share_label_idx: { refused: 'MAP_NAME_TAKEN', by: 'MapService.createShare' },
  map_share_token_hash_key: { unreachable: 'the hash of a random token' },
  report_pkey: { unreachable: 'generated' },
  report_access_pkey: { unreachable: 'ON CONFLICT (report_id, group_id)' },
  report_run_pkey: { unreachable: 'generated' },
  report_run_active_idx: {
    refused: 'REPORT_BUSY',
    by: 'ReportRunRepository.claim, where the index is the lock',
  },
  report_output_pkey: { unreachable: 'generated' },
  report_output_run_id_format_key: { unreachable: 'ON CONFLICT (run_id, format)' },
  library_pkey: { unreachable: 'generated' },
  library_access_pkey: { unreachable: 'ON CONFLICT (library_id, group_id)' },

  // ── discovery ────────────────────────────────────────────────────────────────────────────
  discovery_run_pkey: { unreachable: 'generated' },
  discovery_schedule_pkey: { unreachable: 'generated' },
  discovery_host_pkey: { unreachable: 'the probe endpoint only, ON CONFLICT DO NOTHING' },
  discovery_problem_pkey: { unreachable: 'deduplicated by address, then ON CONFLICT DO UPDATE' },

  // ── the migrator ─────────────────────────────────────────────────────────────────────────
  schema_migration_pkey: { unreachable: 'the migrator only, under its advisory lock' },
} as const satisfies Readonly<Record<string, UniqueRule>>;

export type UniqueConstraintName = keyof typeof UNIQUE_CONSTRAINTS;

/** The rules a route can break, each answered by its own refusal. */
export type RefusedConstraintName = {
  [K in UniqueConstraintName]: (typeof UNIQUE_CONSTRAINTS)[K] extends { refused: string }
    ? K
    : never;
}[UniqueConstraintName];

/**
 * `write`, refused when something is in the way (`P-391`).
 *
 * `inTheWay` reads what holds the value `write` is about to take and returns the refusal that
 * names it, or null. It is asked before the write, and again when the write breaks `constraint`
 * anyway: a row another transaction committed after the first look is visible to the second. The
 * write runs in a savepoint, so the transaction can still be read from once the constraint has
 * refused it. Any other failure, and that one with nothing found the second time, goes out as it
 * came.
 */
export async function refusingTaken<T>(
  q: Queryable,
  constraint: RefusedConstraintName,
  inTheWay: (q: Queryable) => Promise<Error | null>,
  write: (q: Queryable) => Promise<T>,
): Promise<T> {
  const before = await inTheWay(q);
  if (before !== null) throw before;
  try {
    return await savepoint(q, write);
  } catch (error) {
    if (uniqueViolation(error) === constraint) {
      const after = await inTheWay(q);
      if (after !== null) throw after;
    }
    throw error;
  }
}
