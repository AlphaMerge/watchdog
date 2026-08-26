import type { Migration } from './types.js';

/**
 * Notification templates (`N-05`).
 *
 * A trigger says *when* to notify (`N-01`); a template says **what is sent and how**. They are
 * separate because one template serves many triggers — "page the on-call rota" is written once —
 * and because the two are edited by different people at different times.
 *
 * **A library object, not a tree object.** Like a schedule (`M-09`) and unlike everything in
 * `object`: many triggers reference one template and none contains it, so it has no parent, no
 * inheritance and no place in the hierarchy. That is also why `notification_trigger.settings`
 * holds template ids in `jsonb` and no foreign key can enforce them — the reference lives inside
 * a document. `TemplateService` refuses to delete a template a trigger still names, which is the
 * same guarantee arrived at from the other side, and `CAPABILITIES.MD §5.2`'s "used by" reverse
 * lookup is the query that makes it explainable rather than merely refused.
 *
 * **Method settings are jsonb behind a JSON Schema**, exactly as `sensor_config.params` and
 * `notification_trigger.settings` are. Five methods in v1 sharing almost no fields, five more in
 * `[V2]`, and the schema is what generates the form, validates the API and marks the secrets —
 * one declaration rather than a column set per method and a migration every time one arrives.
 *
 * **Secrets never come back.** A Slack incoming-webhook URL *is* a credential: anybody holding
 * it can post to the channel. So the fields that carry one are marked `writeOnly` in their
 * method's schema and stripped at one place — `TemplateService.#redact` — the same arrangement
 * `CLAUDE.md` mandates for monitored-device credentials and for the same reason: a new endpoint
 * cannot forget what it never sees.
 */
export const migration018: Migration = {
  id: 18,
  name: 'notification-templates',

  up: `
    CREATE TABLE notification_template (
      id          bigserial PRIMARY KEY,
      -- Unique, because a template is chosen from a list by name and two called "On-call" is a
      -- configuration nobody can review.
      name        text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
      description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),

      method      text NOT NULL CHECK (length(method) BETWEEN 1 AND 40),
      settings    jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),

      -- What is written, with N-06's placeholders left exactly as the operator typed them.
      -- Substitution happens at delivery, never here: a stored message with the values already
      -- filled in would describe the outage that was in progress when somebody edited the
      -- template.
      subject     text NOT NULL DEFAULT '' CHECK (length(subject) <= 500),
      body        text NOT NULL DEFAULT '' CHECK (length(body) <= 20000),

      -- Users, user groups or raw addresses (CAPABILITIES.MD §5.2). Only addresses resolve until
      -- A-01 and A-02 exist; the other two kinds validate and are refused at delivery with a
      -- reason, which is better than a schema that has to change when accounts arrive.
      recipients  jsonb NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(recipients) = 'array'),

      -- 1 highest to 5 lowest, matching what an email header carries and what an operator reads
      -- on the template list. 3 is normal.
      priority    smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),

      -- Off without being deleted: silencing a delivery method for an afternoon should not mean
      -- rebuilding it, and a deleted template takes every trigger's reference with it.
      enabled     boolean NOT NULL DEFAULT true,

      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TRIGGER notification_template_set_updated_at
      BEFORE UPDATE ON notification_template
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---------------------------------------------------------------------------------------
    -- Deliberately NO foreign key from notification_request.template_id.
    --
    -- The obvious thing to do now that the table exists, and it would reverse a decision N-02
    -- made on purpose: a trigger names its templates inside a jsonb document, so nothing can
    -- stop it naming one that does not exist, and refusing to record the obligation would lose
    -- it rather than surface it. A queued request pointing at a missing template is a
    -- configuration mistake the operator needs to be told about — WORKFLOW.MD §6 is explicit
    -- that delivery failure is itself an alarm — not a row the database should have refused.
    -- N-07 reports it; Core Health carries it.
    -- ---------------------------------------------------------------------------------------
  `,

  down: `
    DROP TRIGGER IF EXISTS notification_template_set_updated_at ON notification_template;
    DROP TABLE IF EXISTS notification_template;
  `,
};
