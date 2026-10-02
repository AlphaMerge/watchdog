import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

/**
 * Whether a certificate is for the host a TLS connection was made to: Node's own check, except
 * for an IPv6 address (`A-60`, shared by every TLS client here since `A-67`).
 *
 * **Node's check takes an IPv6 address for a name, and no certificate can pass it.** Measured on
 * 24.19: `tls.checkServerIdentity` puts the host through `domainToASCII` before it asks whether
 * it is an address, `::1` is not a domain, and what comes back is the empty string — so the
 * address is matched as a DNS name against a certificate that rightly has none for it, and a
 * connection to `::1` fails with "Host: ::1. is not cert's CN" under a certificate whose subject
 * alternative names list that very address. An IPv4 address survives the conversion and is
 * checked as one. So anything that verifies a certificate and is given an IPv6 address — a
 * webhook URL, a mail relay, a device, a probe's core — could not connect at all.
 *
 * The address is asked of the certificate itself, by OpenSSL (`X509Certificate.checkIP`), and
 * not read out of the `subjectaltname` string: that string quotes and escapes what a hostile
 * certificate puts in a name, and a second parser of it is a second thing to get wrong. Only
 * an address the certificate lists as an address passes — never a DNS name or a common name
 * spelt like one. A certificate with nothing to ask is refused.
 *
 * Whether the certificate is *trusted* is not decided here, and is as it was: this is passed as
 * a connection's `checkServerIdentity` and changes nothing about `rejectUnauthorized`, the
 * certificate authorities or what is sent as the server name. `host` is what Node hands that
 * hook — the server name where one was set, otherwise the host connected to.
 */
export function serverIdentity(host: string, certificate: PeerCertificate): Error | undefined {
  if (isIP(host) !== 6) return checkServerIdentity(host, certificate);
  let listed = false;
  try {
    listed = new X509Certificate(certificate.raw).checkIP(host) !== undefined;
  } catch {
    listed = false;
  }
  if (listed) return undefined;
  const names = certificate.subjectaltname ?? '';
  return Object.assign(
    new Error(
      `Hostname/IP does not match certificate's altnames: IP: ${host} is not in the cert's list: ${names}`,
    ),
    { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
  );
}
