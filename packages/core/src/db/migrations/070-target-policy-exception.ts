import type { Migration } from './types.js';

/**
 * One device's exception to its probe's target policy (`A-64`).
 *
 * The addresses of this device its probe may connect to although `probe.targetPolicy` refuses
 * them. **A column on `device_config`, not an `object_setting`**, for the reason the host is one
 * (002): it is not inheritable. A setting in the registry is resolved down the tree, and an
 * exception a group could carry would exempt every device beneath it, including those added
 * later by whoever may write the group. On the device it can never exempt more than the device
 * it names.
 *
 * Written only by `ObjectService.setTargetPolicyException`, behind a route only an administrator
 * clears, and each write is a device update: `device_config_touch_owner` bumps the object's
 * version, which is what moves its ETag, and the audit entry is what pushes the probe its new
 * configuration. A clone, a template and discovery insert `device_config` naming the host and the
 * family only, so a new device starts with none.
 *
 * What an entry may be (an address, never a range, a name or a metadata service) is
 * `exceptionProblem`'s, checked by the service; the table bounds the count, and refuses NULL
 * and an empty string, which no write of ours produces.
 *
 * The rollback drops the column. What it loses is every exception: the build before has none,
 * and its probes refuse those addresses as the policy says.
 */
export const migration070: Migration = {
  id: 70,
  name: 'target-policy-exception',

  up: `
    ALTER TABLE device_config
      ADD COLUMN target_policy_exception text[] NOT NULL DEFAULT '{}'
        CONSTRAINT device_config_target_policy_exception_bounded CHECK (
          cardinality(target_policy_exception) <= 16
          AND array_position(target_policy_exception, NULL) IS NULL
          AND array_position(target_policy_exception, '') IS NULL
        );

    COMMENT ON COLUMN device_config.target_policy_exception IS
      'Addresses of this device its probe may connect to although its target policy refuses them; set by an administrator, never inherited (A-64).';
  `,

  down: `
    ALTER TABLE device_config DROP COLUMN target_policy_exception;
  `,
};
