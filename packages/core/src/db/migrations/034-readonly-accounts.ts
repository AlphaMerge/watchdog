import type { Migration } from './types.js';

/**
 * Read-only account restrictions (`A-04`, `CAPABILITIES.MD §14`).
 *
 * **A role is a ceiling, not a starting point, and that is the whole of this ticket.** `A-03`
 * resolves what an account's *groups* grant on an object. This caps that answer by what the
 * account is allowed to be: a read-only account holding `full` through some group still may not
 * write, because somebody made it read-only on purpose and a group membership is not a way to
 * undo that. Enforced in one place, for the same reason redaction is.
 *
 * **Acknowledging is the one exception, and it is opt-in per account.** An operator who may look
 * but not change is exactly the person on the end of a phone at 3am, and "silence this alarm, I
 * am dealing with it" is not a change to the monitored estate — it is a note on an alarm. PRTG
 * makes it a separate permission for the same reason. Off by default: a permission that grants
 * itself is not a permission.
 */
export const migration034: Migration = {
  id: 34,
  name: 'readonly-accounts',

  up: `
    -- Lets a read-only account acknowledge alarms. Meaningless for the other roles — they can
    -- already — and harmless to set on them, so there is no check tying it to a role: a rule
    -- that says "this column only applies when that column says X" is a rule somebody has to
    -- remember when they change X.
    ALTER TABLE user_account
      ADD COLUMN may_acknowledge boolean NOT NULL DEFAULT false;

    -- **A read-only account cannot be in an administrator group**, checked here as well as in
    -- the service. Two enforcement points for one rule is usually a smell; this one is worth it,
    -- because the failure is silent and total — an account somebody believes is read-only that
    -- administers the installation — and because there are three different ways in: making an
    -- existing account read-only, adding a read-only account to an admin group, and making a
    -- group administrative under a read-only member.
    --
    -- **One function per table rather than one that branches on TG_TABLE_NAME.** PL/pgSQL
    -- resolves every field reference in a statement it runs, so a single function naming both
    -- NEW.id and NEW.user_id fails on whichever table lacks the other — regardless of the
    -- condition guarding it.
    CREATE FUNCTION assert_account_not_readonly_admin() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.role = 'readonly' AND EXISTS (
          SELECT 1 FROM user_group_member m JOIN user_group g ON g.id = m.group_id
          WHERE m.user_id = NEW.id AND g.is_admin
        ) THEN
          RAISE EXCEPTION
            'account % is read-only and cannot be in a group that administers the installation',
            NEW.login USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;

    CREATE FUNCTION assert_member_not_readonly_admin() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM user_account a JOIN user_group g ON g.id = NEW.group_id
          WHERE a.id = NEW.user_id AND a.role = 'readonly' AND g.is_admin
        ) THEN
          RAISE EXCEPTION
            'that account is read-only and cannot be in a group that administers the installation'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;

    -- The third way in: the account and the membership stay as they are, and the *group* becomes
    -- administrative underneath them.
    CREATE FUNCTION assert_group_not_readonly_admin() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.is_admin AND EXISTS (
          SELECT 1 FROM user_group_member m JOIN user_account a ON a.id = m.user_id
          WHERE m.group_id = NEW.id AND a.role = 'readonly'
        ) THEN
          RAISE EXCEPTION
            'group % has read-only members and cannot be made to administer the installation',
            NEW.name USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER user_account_not_readonly_admin
      AFTER UPDATE OF role ON user_account
      FOR EACH ROW EXECUTE FUNCTION assert_account_not_readonly_admin();

    CREATE TRIGGER user_group_member_not_readonly_admin
      AFTER INSERT OR UPDATE ON user_group_member
      FOR EACH ROW EXECUTE FUNCTION assert_member_not_readonly_admin();

    CREATE TRIGGER user_group_not_readonly_admin
      AFTER UPDATE OF is_admin ON user_group
      FOR EACH ROW EXECUTE FUNCTION assert_group_not_readonly_admin();
  `,

  down: `
    DROP TRIGGER IF EXISTS user_group_not_readonly_admin ON user_group;
    DROP TRIGGER IF EXISTS user_group_member_not_readonly_admin ON user_group_member;
    DROP TRIGGER IF EXISTS user_account_not_readonly_admin ON user_account;
    DROP FUNCTION IF EXISTS assert_group_not_readonly_admin();
    DROP FUNCTION IF EXISTS assert_member_not_readonly_admin();
    DROP FUNCTION IF EXISTS assert_account_not_readonly_admin();
    ALTER TABLE user_account DROP COLUMN IF EXISTS may_acknowledge;
  `,
};
