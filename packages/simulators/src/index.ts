/**
 * The protocol simulator harness (`P-06`).
 *
 * **A deliverable, not a test fixture** — `PLAN.md` says so, and the distinction is the whole
 * reason this is a package rather than a directory under one workspace's `test/`. Every sensor
 * type in this system is required to ship tests against a simulator rather than a live network
 * target (`CLAUDE.md`), so the harness is what makes that rule affordable: writing an SNMP agent
 * that walks backwards, or an SMTP relay that accepts a connection and refuses at `RCPT TO`, costs
 * more than the test it supports, and nobody writes it twice.
 *
 * **Most of it arrived early, ticket by ticket, and this is where it was always going.** The SNMP
 * agent said so in its own header from `T-01`: "when `P-06` builds the rest, this is the piece to
 * move rather than to write again." The mail servers came with `T-17`, the SSH server with `T-07`,
 * the PowerShell stand-in with `T-09`. They lived in `packages/sensors/test/support/`, which meant
 * the core's and the probe's tests could not reach them — so the probe wrote its own syslog sender
 * and seven test files each stood up their own HTTP server. That duplication is what this ends.
 *
 * **Two rules run through all of it.**
 *
 * *Real sockets, never interception.* Everything here binds a port and speaks the protocol. A
 * library-level mock asserts that the code called the function the test said it would call; a
 * redirect that our client mishandles is a redirect an interceptor never sees.
 *
 * *Never the code under test.* The syslog sender renders its own bytes rather than calling
 * `@ms/sensors`' renderer, and the SNMP agent is hand-written rather than being `net-snmp`'s own —
 * because a harness built from the thing it tests is a closed loop that passes whether or not
 * either side is right. `ssh2.Server` is the deliberate exception, and its file says why: the
 * cases worth testing there are all things a *correct* server does.
 *
 * **Not here: the flow exporter** `P-06`'s description lists. NetFlow and IPFIX are deferred to
 * v2 (`CLAUDE.md`), so a simulator for them would be a harness with nothing to test.
 */

export { listen, close } from './net.js';

export {
  HttpSimulator,
  type HttpResponseScript,
  type HttpSimulatorOptions,
  type RecordedRequest,
} from './http-server.js';

export {
  TestSnmpAgent,
  type AgentBehaviour,
  type AgentEntry,
  type AgentValueType,
} from './snmp-agent.js';

export {
  TestSshServer,
  keyPair,
  type CommandResult,
  type SshServerBehaviour,
} from './ssh-server.js';

export {
  Mailbox,
  imapServer,
  pop3Server,
  smtpServer,
  type MailServerOptions,
  type Message,
  type RunningServer,
} from './mail-servers.js';

export { installFakePowerShell } from './fake-powershell.js';

export {
  renderMessage,
  sendTcp,
  sendUdp,
  type SyslogFormat,
  type SyslogMessageOptions,
  type TcpFraming,
} from './syslog-sender.js';

export {
  exportNetflowV5,
  renderIpfix,
  renderNetflowV5,
  renderNetflowV9,
  variableLength,
  type DataSetSpec,
  type ExportedFlow,
  type ExportOptions,
  type FlowSetExportOptions,
  type TemplateFieldSpec,
  type TemplateSpec,
} from './netflow-exporter.js';

export {
  ethernetFrame,
  renderSflow,
  type EthernetFrameSpec,
  type SflowExportOptions,
  type SflowSampleSpec,
} from './netflow-exporter.js';
