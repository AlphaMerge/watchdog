import type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  JsonSchema,
  SensorType,
} from '../contract.js';
import { authorizationFor, scrub, secretsOf } from '../support/http/auth.js';
import { extract, MAX_PATTERN, PatternError } from '../support/pattern.js';
import { isCredentialsWithheld } from '../support/pinned-target.js';
import { scrubberOf } from '../support/secrets.js';
import { HTTP_COMMON_SCHEMA } from './http-shared.js';

/**
 * A sequence of requests that has to work end to end (`T-15`).
 *
 * **This is the sensor for a login, not for a page.** Every other HTTP type asks one question of
 * one URL. What an operator actually wants to know about a web application is whether somebody
 * can sign in and reach the thing they came for — and that is a form, a POST, a session cookie
 * and a page behind it, where each part answers 200 while the whole is broken. A login page that
 * renders perfectly and rejects every password is four healthy sensors and one useless
 * application.
 *
 * **Five sensors in a row would not do this**, for three reasons that are all the same reason:
 * they do not share a session, they do not run in order, and five failures is five alarms for
 * one outage. Here the cookie jar carries between steps, a step that fails ends the transaction,
 * and there is exactly one sensor to alarm on.
 *
 * **The failure names the step.** "Step 3 of 5 (open the dashboard) answered 302 to /login"
 * is a diagnosis; "the transaction failed" is a ticket somebody has to reproduce by hand. The
 * per-step timings are channels for the same reason: a checkout that got slower got slower
 * *somewhere*, and one total tells you nothing about where.
 *
 * **Captured variables are how a step reaches the next one.** A CSRF token in the login form, an
 * id in a JSON response, a redirect target — captured by pattern from one response and
 * substituted as `{{name}}` into the next. Credentials substitute the same way, from the
 * device's `http` credential rather than from the parameters, and **every secret is scrubbed out
 * of the message before it leaves this function**: a failure message is stored on the state log
 * and returned by the API, so a password in one is a password the API hands out.
 *
 * **A credential goes in the `Authorization` header or the body, and nowhere else** (`A-42`). See
 * `misplacedCredentials`. And every response is scrubbed of the check's secrets as it arrives,
 * before a content check, a capture or a message reads it: a server that echoes what it was sent
 * would otherwise hand the credential to the next step, or answer a `mustContain` guess.
 */

const MAX_STEPS = 10;
const MAX_CAPTURES = 5;
const MAX_HEADERS = 10;

/** Enough of a page to find a CSRF token in. Bounded so a worker survives a big download. */
const DEFAULT_MAX_BODY = 512 * 1024;

interface Capture {
  readonly name: string;
  readonly pattern: string;
}

interface Step {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly expectStatus: string;
  readonly mustContain: string;
  readonly mustNotContain: string;
  readonly capture: readonly Capture[];
}

const text = (record: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exported for its own tests: a step list read wrongly is a transaction testing the wrong thing. */
export function readSteps(params: Readonly<Record<string, unknown>>): Step[] {
  const raw = params['steps'];
  if (!Array.isArray(raw)) return [];
  const out: Step[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    let path = text(entry, 'path', '/');
    if (path === '' || !path.startsWith('/')) path = `/${path}`;

    const headers: { name: string; value: string }[] = [];
    if (Array.isArray(entry['headers'])) {
      for (const header of entry['headers']) {
        if (!isRecord(header)) continue;
        const name = text(header, 'name').trim();
        if (name !== '') headers.push({ name, value: text(header, 'value') });
      }
    }

    const capture: Capture[] = [];
    if (Array.isArray(entry['capture'])) {
      for (const one of entry['capture']) {
        if (!isRecord(one)) continue;
        const name = text(one, 'name').trim();
        if (name !== '') capture.push({ name, pattern: text(one, 'pattern') });
      }
    }

    out.push({
      name: text(entry, 'name').trim() === '' ? path : text(entry, 'name').trim(),
      method: text(entry, 'method', 'GET'),
      path,
      body: text(entry, 'body'),
      headers,
      expectStatus: text(entry, 'expectStatus').trim(),
      mustContain: text(entry, 'mustContain'),
      mustNotContain: text(entry, 'mustNotContain'),
      capture,
    });
  }
  return out;
}

/**
 * `{{name}}` becomes what a previous step captured, or a credential field.
 *
 * **An unknown name fails rather than substituting nothing.** A login POST whose `{{csrf}}`
 * quietly became the empty string is a request the server rejects for a reason that has nothing
 * to do with the application being down, and the sensor would report the rejection rather than
 * the typo.
 */
export function substitute(
  template: string,
  variables: ReadonlyMap<string, string>,
  where: string,
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_whole, name: string) => {
    const value = variables.get(name);
    if (value === undefined) {
      throw new Error(
        `${where} uses {{${name}}}, which no earlier step captured and no credential provides` +
          (variables.size === 0
            ? ''
            : ` — what is available here is ${[...variables.keys()].join(', ')}`),
      );
    }
    return value;
  });
}

/** `{{credential.…}}`, read as `substitute` reads a name. */
const CREDENTIAL_REFERENCE = /\{\{\s*(credential\.[A-Za-z0-9_.]+)\s*\}\}/;

/**
 * Every place a step names a credential that is not its `Authorization` header or its body
 * (`A-42`), as the JSON Pointer of the value and a sentence saying which step and which field.
 *
 * **Why those two and no others.** `{{credential.password}}` substitutes into whatever text
 * names it, and the sensor's writer chooses that text without being able to read the device's
 * `http` credential. A path is a query string that servers and proxies log, and a custom header
 * is one a server may send straight back. Either puts a password the writer was never shown
 * somewhere they can read it. The header a server treats as a credential, and the body a login
 * form posts, are the two places a transaction needs one.
 *
 * Read twice. `paramProblems` refuses a sensor that does this when it is written. `execute`
 * refuses to run one written before the rule, before it sends anything, in the same words.
 * Exported for its own tests.
 */
export function misplacedCredentials(
  params: Readonly<Record<string, unknown>>,
): { path: string; message: string }[] {
  const raw = params['steps'];
  if (!Array.isArray(raw)) return [];
  const out: { path: string; message: string }[] = [];
  for (const [at, entry] of raw.entries()) {
    if (!isRecord(entry)) continue;
    const path = text(entry, 'path', '/');
    const name = text(entry, 'name').trim();
    const where = `step ${String(at + 1)} (${name === '' ? path : name})`;
    const refused = (pointer: string, field: string, value: string): void => {
      const found = CREDENTIAL_REFERENCE.exec(value);
      if (found === null) return;
      out.push({
        path: pointer,
        message:
          `${where} puts {{${found[1] ?? 'credential'}}} in its ${field}, and a credential may go ` +
          'only in the Authorization header or the body — a server or a proxy logs the rest, and ' +
          'may send it back',
      });
    };
    refused(`/steps/${String(at)}/path`, 'path', path);
    if (Array.isArray(entry['headers'])) {
      for (const [index, header] of entry['headers'].entries()) {
        if (!isRecord(header)) continue;
        const headerName = text(header, 'name').trim();
        if (headerName.toLowerCase() === 'authorization') continue;
        refused(
          `/steps/${String(at)}/headers/${String(index)}/value`,
          `${headerName === '' ? 'unnamed' : headerName} header`,
          text(header, 'value'),
        );
      }
    }
  }
  return out;
}

const STEP_SCHEMA: JsonSchema = {
  // The singular, for `U-12`'s repeating control: the fieldset is named for the parameter
  // ("Steps") and an entry inside it wants this.
  title: 'Step',
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    name: {
      type: 'string',
      maxLength: 60,
      default: '',
      title: 'Step name',
      description:
        'What this step is for — “sign in”, “open the dashboard”. It names the channel and it ' +
        'is what the failure message says, so write it for whoever is reading it at 3 a.m.',
    },
    method: {
      enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      default: 'GET',
      title: 'Method',
    },
    path: {
      type: 'string',
      maxLength: 2_048,
      title: 'Path',
      description:
        'After {{substitution}}. Never a credential: servers and proxies log a path, query ' +
        'string and all, so {{credential.*}} here is refused.',
    },
    body: {
      type: 'string',
      maxLength: 16_384,
      default: '',
      title: 'Request body',
      description:
        'Sent as-is, after {{substitution}}. A password belongs here as ' +
        '{{credential.password}}, never as itself — a password typed into a sensor parameter is ' +
        'returned by the API to anybody who can read the sensor.',
    },
    headers: {
      type: 'array',
      maxItems: MAX_HEADERS,
      default: [],
      title: 'Request headers',
      items: {
        // The singular, for `U-12`'s repeating control: the fieldset is named for the
        // parameter and an entry inside it wants this.
        title: 'Header',
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200, title: 'Header' },
          value: {
            type: 'string',
            maxLength: 2_048,
            default: '',
            title: 'Value',
            description:
              'After {{substitution}}. {{credential.*}} is accepted only in an Authorization ' +
              'header: a server may log any other, or send it back.',
          },
        },
      },
    },
    expectStatus: {
      type: 'string',
      maxLength: 32,
      pattern: '^$|^[1-5](?:[0-9]{2}|xx)(?:-[1-5][0-9]{2})?$',
      default: '',
      title: 'Expected status',
      description: 'Empty accepts any 2xx, and any 3xx when redirects are not being followed.',
    },
    mustContain: {
      type: 'string',
      maxLength: 500,
      default: '',
      title: 'Response must contain',
      description:
        'Plain text, ignoring case. This is usually what proves the step *worked* rather than ' +
        'merely answered — a login that failed returns the login form with a cheerful 200.',
    },
    mustNotContain: {
      type: 'string',
      maxLength: 500,
      default: '',
      title: 'Response must not contain',
    },
    capture: {
      type: 'array',
      maxItems: MAX_CAPTURES,
      default: [],
      title: 'Capture for later steps',
      description:
        'Each pattern is matched against this step’s response and the first capture group is ' +
        'kept under the name given, for {{substitution}} into any later step.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'pattern'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 40,
            pattern: '^[A-Za-z0-9_]+$',
            title: 'Name',
          },
          pattern: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_PATTERN,
            title: 'Pattern',
            description:
              'A regular expression with one capture group — name="csrf" value="([^"]+)".',
          },
        },
      },
    },
  },
};

export const httpTransaction: SensorType = {
  id: 'http.transaction',
  category: 'Web',
  // Up to ten requests, and it holds a session across them.
  costHint: 'heavy',
  credentialKinds: ['http'],
  pinnedKinds: ['http'],
  // Where the set goes besides the host (`A-41`): a port, and whether it is encrypted and checked.
  secretDestinations: { 'kind:http': ['port', 'scheme', 'verifyTls'] },

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['steps'],
    properties: {
      scheme: HTTP_COMMON_SCHEMA['scheme'] as JsonSchema,
      port: HTTP_COMMON_SCHEMA['port'] as JsonSchema,
      followRedirects: HTTP_COMMON_SCHEMA['followRedirects'] as JsonSchema,
      verifyTls: HTTP_COMMON_SCHEMA['verifyTls'] as JsonSchema,
      userAgent: HTTP_COMMON_SCHEMA['userAgent'] as JsonSchema,
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 300_000,
        default: 10_000,
        title: 'Timeout per step',
        description:
          'Per step, not for the whole transaction — ten steps at ten seconds is a sensor that ' +
          'can take a hundred, so keep the scan interval well above the total.',
      },
      maxBodyBytes: {
        type: 'integer',
        minimum: 1_024,
        maximum: 8 * 1024 * 1024,
        default: DEFAULT_MAX_BODY,
        title: 'Response bound',
        description:
          'How much of each response is read, for the content checks and the captures. Passing ' +
          'it fails the step rather than truncating: a token searched for in half a page is ' +
          '“not found”, which is a far more confusing fault than “this page is bigger than this ' +
          'sensor reads”.',
      },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_STEPS,
        title: 'Steps',
        description:
          'Run in order, sharing one cookie jar. The first step that fails ends the transaction ' +
          '— one outage is one alarm, and the steps after a failed login would all fail for the ' +
          'same reason.',
        items: STEP_SCHEMA,
      },
    },
  },

  paramProblems: misplacedCredentials,

  // Every reading is keyed by a channel `channels(params)` names for the same parameters, so one
  // an edit no longer names is retired (`P-310`).
  declaresEveryChannel: true,

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const steps = readSteps(params);
    return [
      { key: 'totalTime', name: 'Transaction time', unit: 'ms', isPrimary: true },
      // Keyed by position rather than by name, so renaming a step does not orphan its history.
      // A checkout that got slower got slower somewhere, and one total says nothing about where.
      ...steps.map((step, at) => ({
        key: `step${String(at + 1)}`,
        name: step.name,
        unit: 'ms',
      })),
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { fetchHttp, readCommon, statusAccepted } = await import('../support/http/request.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to request');

    const steps = readSteps(context.params);
    if (steps.length === 0) throw new Error('this sensor has no steps to run');
    // Saved before the rule (`A-42`): refused before anything is sent, never quietly repaired.
    const misplaced = misplacedCredentials(context.params);
    const first = misplaced[0];
    if (first !== undefined) {
      throw new Error(
        `${first.message}${misplaced.length > 1 ? ` (and ${String(misplaced.length - 1)} more)` : ''}` +
          '. This sensor was saved before that was refused: edit it to move the credential, ' +
          'and it runs again',
      );
    }
    // S-19's scrub, as the catalogue hands it over: every response passes through it (`A-42`).
    const scrubbed = scrubberOf(context);

    const common = readCommon(context.params, context.target);
    const agent = context.params['userAgent'];
    const userAgent = typeof agent === 'string' && agent.trim() !== '' ? agent.trim() : '';
    const maxBodyBytes = Number(context.params['maxBodyBytes'] ?? DEFAULT_MAX_BODY);

    // One jar for the whole transaction, and the reason this sensor exists rather than five.
    const cookies = new Map<string, string>();
    const variables = new Map<string, string>();
    const credential = context.credentials['http'] ?? {};
    const secrets = secretsOf(credential);
    for (const key of ['username', 'password', 'token']) {
      const value = credential[key];
      if (typeof value === 'string' && value !== '') variables.set(`credential.${key}`, value);
    }
    const authorization = authorizationFor(credential);

    const timings: { key: string; value: number }[] = [];
    let total = 0;

    for (const [at, step] of steps.entries()) {
      const where = `step ${String(at + 1)} of ${String(steps.length)} (${step.name})`;
      const fail = (why: string): never => {
        throw new Error(scrub(`${where} ${why}`, secrets));
      };

      const headers: Record<string, string> = {
        'user-agent': userAgent === '' ? 'MonitoringSystem/1.0 (+sensor)' : userAgent,
        ...(authorization === null ? {} : { authorization }),
      };
      for (const header of step.headers) {
        headers[header.name.toLowerCase()] = substitute(header.value, variables, where);
      }
      const path = substitute(step.path, variables, where);
      const body = substitute(step.body, variables, where);

      const response = await fetchHttp(
        {
          ...common,
          path,
          method: step.method,
          body,
          headers,
          maxBodyBytes,
          cookies,
        },
        context.signal,
      ).catch((error: unknown) => {
        // A refusal over where the credentials may go keeps its class (`A-41c`): rewrapped, it
        // would read as a failed step, and the sensor Down for a device nothing was sent to.
        if (isCredentialsWithheld(error)) throw error;
        throw new Error(
          scrub(
            `${where} failed: ${error instanceof Error ? error.message : String(error)}`,
            secrets,
          ),
        );
      });

      total += response.totalMs;
      timings.push({ key: `step${String(at + 1)}`, value: response.totalMs });
      // Before anything reads it (`A-42`). A server that echoes the credential it was sent would
      // otherwise hand it to a capture, and from there to a later step's path. And a writer could
      // learn it by `mustContain` guesses, one character at a time, from the sensor going Down.
      const answer = scrubbed(response.body);

      if (!statusAccepted(response.status, step.expectStatus, common.followRedirects)) {
        fail(
          `answered ${String(response.status)}` +
            (step.expectStatus === '' ? '' : `, and expects ${step.expectStatus}`) +
            (response.unfollowedLocation === null
              ? ''
              : ` pointing at ${response.unfollowedLocation}`),
        );
      }
      if (response.size > maxBodyBytes) {
        fail(
          `returned ${String(response.size)} bytes, larger than the ${String(maxBodyBytes)} bytes ` +
            'this sensor reads — a check against half a response is worse than no check',
        );
      }
      if (
        step.mustContain !== '' &&
        !answer.toLowerCase().includes(step.mustContain.toLowerCase())
      ) {
        // The step every login transaction needs: a rejected sign-in returns the sign-in form,
        // with a 200 on it and a session cookie and everything else looking perfect.
        fail(`answered ${String(response.status)} but does not contain "${step.mustContain}"`);
      }
      if (
        step.mustNotContain !== '' &&
        answer.toLowerCase().includes(step.mustNotContain.toLowerCase())
      ) {
        fail(`answered ${String(response.status)} but contains "${step.mustNotContain}"`);
      }

      for (const capture of step.capture) {
        const found = captureOne(answer, capture, maxBodyBytes);
        if (found === null) {
          fail(
            `did not match /${capture.pattern}/, so {{${capture.name}}} has nothing to give the ` +
              'steps after it',
          );
        } else {
          variables.set(capture.name, found);
        }
      }
    }

    return {
      channels: [{ key: 'totalTime', value: Math.round(total * 100) / 100 }, ...timings],
      message:
        `${String(steps.length)} steps in ${String(Math.round(total))} ms` +
        (timings.length < 2 ? '' : `; slowest was ${slowestOf(steps, timings)}`),
    };
  },
};

/** One capture, through the sandbox — the pattern is an operator's, the text is a server's. */
function captureOne(body: string, capture: Capture, maxSubject: number): string | null {
  let found;
  try {
    found = extract(body, capture.pattern, 'match', undefined, maxSubject);
  } catch (error) {
    if (error instanceof PatternError) throw new Error(error.message);
    throw error;
  }
  if (found.kind === 'too-slow') {
    throw new Error(
      `/${capture.pattern}/ was still running after ${String(found.afterMs)} ms and was stopped ` +
        '— a nested quantifier like (a+)+ backtracks for ever on text that nearly matches',
    );
  }
  return found.kind === 'value' ? found.matched : null;
}

function slowestOf(
  steps: readonly Step[],
  timings: readonly { key: string; value: number }[],
): string {
  let worst = 0;
  for (let at = 1; at < timings.length; at += 1) {
    if ((timings[at]?.value ?? 0) > (timings[worst]?.value ?? 0)) worst = at;
  }
  return `${steps[worst]?.name ?? ''} at ${String(Math.round(timings[worst]?.value ?? 0))} ms`;
}
