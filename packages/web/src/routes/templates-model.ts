import type { NotificationMethod, TemplateInput, TemplateView } from '../api/types';
import { seedDefaults } from '../forms/schema';

/**
 * The template form's draft: what a new one starts as, and what an edit rebuilds from the read.
 *
 * Separate from the view because the rebuild is the subtle half — a PUT that omits a setting
 * keeps the stored one, which is what makes editing a subject line safe on a template holding a
 * webhook URL — and `test/template-draft.test.ts` asserts it without rendering a form. A module
 * exporting both a component and a function cannot Fast Refresh either.
 */

export function initial(
  template: TemplateView | undefined,
  methods: readonly NotificationMethod[],
): TemplateInput {
  if (template === undefined) {
    const first = methods[0];
    return {
      name: '',
      method: first?.id ?? 'email',
      // Seeded from the method's own defaults, which the core applies and stores anyway — the
      // same rule the sensor-parameter form follows when adding rather than editing (`U-08`).
      settings: seed(first?.settingsSchema),
      subject: '%sitename: %sensor on %device is %status',
      body: '%lastmessage\n\n%linksensor',
      recipients: [],
      priority: 3,
      enabled: true,
    };
  }
  // Rebuilt from the read, which carries no secrets — and must not. A PUT that omits one keeps
  // the stored value; `N-05` merges rather than clearing, which is what makes editing a subject
  // line safe on a template with a webhook URL in it.
  return {
    name: template.name,
    description: template.description,
    method: template.method,
    settings: template.settings,
    subject: template.subject,
    body: template.body,
    recipients: template.recipients,
    priority: template.priority,
    enabled: template.enabled,
    summarisation: template.summarisation,
    summaryWindowSeconds: template.summaryWindowSeconds,
    scheduleId: template.scheduleId,
    whenInactive: template.whenInactive,
  };
}

/** A method's settings pre-filled from the defaults its schema declares. */
export function seed(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  return seedDefaults(schema ?? {});
}
