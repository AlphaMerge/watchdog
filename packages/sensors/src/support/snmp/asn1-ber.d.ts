/**
 * The part of `asn1-ber` the SNMP test agent uses.
 *
 * `net-snmp` brings it transitively; only `test/support/snmp-agent.ts` speaks BER directly, to
 * build request/response bytes the library would never produce on purpose (see that file for
 * why a hand-rolled agent is the point rather than an inconvenience).
 */
declare module 'asn1-ber' {
  export namespace Ber {
    class Reader {
      constructor(buffer: Buffer);
      readonly remain: number;
      peek(): number;
      readByte(peek?: boolean): number;
      readSequence(tag?: number): number | null;
      readInt(tag?: number): number;
      readString(tag?: number, retbuf?: boolean): string;
      readOID(tag?: number): string;
    }

    class Writer {
      constructor(options?: { size?: number; growthFactor?: number });
      readonly buffer: Buffer;
      writeByte(byte: number): void;
      writeInt(value: number, tag?: number): void;
      writeNull(): void;
      writeString(value: string, tag?: number): void;
      writeBuffer(value: Buffer, tag: number): void;
      writeOID(value: string, tag?: number): void;
      startSequence(tag?: number): void;
      endSequence(): void;
    }
  }
}
