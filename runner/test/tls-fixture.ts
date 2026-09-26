import { generateKeyPairSync, sign } from "node:crypto";

/**
 * A throwaway self-signed certificate for a fictional host, built in memory
 * for `safe-fetch.test.ts`'s local TLS server (round-2 review T4: "Tests use
 * the real transport against a local TLS server"). Nothing is written to
 * disk and no key is committed: every call makes a fresh P-256 key pair and
 * a one-hour certificate whose only name is `hostname` (subjectAltName
 * dNSName, which is what Node's `checkServerIdentity` checks).
 *
 * Node has no API that creates an X.509 certificate, so this encodes the few
 * DER structures one needs (RFC 5280 §4.1) and signs the to-be-signed part
 * with `crypto.sign`, whose ECDSA output is already the DER
 * `ECDSA-Sig-Value` a certificate carries.
 */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, ...items);
const set = (...items: Buffer[]): Buffer => tlv(0x31, ...items);

function objectId(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let n = Math.floor(part / 128); n > 0; n = Math.floor(n / 128)) chunk.unshift((n & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

/** A distinguished name holding only a common name. */
function commonName(name: string): Buffer {
  return sequence(set(sequence(objectId("2.5.4.3"), tlv(0x0c, Buffer.from(name, "utf8")))));
}

export interface TestCertificate {
  /** PKCS#8 PEM private key, in memory only. */
  readonly key: string;
  /** PEM certificate, self-signed: trust it by passing it as `ca`. */
  readonly cert: string;
}

export function selfSignedCertificate(hostname: string): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaWithSha256 = sequence(objectId("1.2.840.10045.4.3.2"));
  const now = Date.now();
  const subjectAltName = sequence(objectId("2.5.29.17"), tlv(0x04, sequence(tlv(0x82, Buffer.from(hostname, "ascii")))));
  const toBeSigned = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // version: v3
    tlv(0x02, Buffer.from([1])), // serial number
    ecdsaWithSha256,
    commonName(hostname), // issuer
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 3_600_000))), // validity
    commonName(hostname), // subject
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, sequence(subjectAltName)), // extensions
  );
  const signature = sign("sha256", toBeSigned, privateKey);
  const der = sequence(toBeSigned, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const base64Lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64Lines.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}
