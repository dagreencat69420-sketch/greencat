import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildSetVrfExpiryIx,
  buildSetVrfExpiryIxChecked,
  deriveConfigPda,
  formatVrfExpiry,
  GREENCAT_PROGRAM_ID,
  IX_DISCRIMINATORS,
  parseVrfExpiryInput,
  VRF_EXPIRY_DEFAULT_SECS,
  VRF_EXPIRY_MAX_SECS,
  VRF_EXPIRY_MIN_SECS,
} from "../src";

const pid = new PublicKey(GREENCAT_PROGRAM_ID);
const admin = Keypair.generate().publicKey;

describe("VRF expiry (/admin Set VRF expiry)", () => {
  it("bounds match the program's production constants (vrf.rs)", () => {
    const rs = fs.readFileSync(path.resolve(__dirname, "../../../programs/greencat/src/vrf.rs"), "utf8");
    const prodMin = rs.match(/#\[cfg\(not\(feature = "localnet-short-windows"\)\)\]\s*pub const VRF_EXPIRY_MIN_SECS: i64 = ([\d_]+);/);
    expect(prodMin && Number(prodMin[1].replace(/_/g, ""))).toBe(VRF_EXPIRY_MIN_SECS);
    expect(rs).toMatch(/pub const VRF_EXPIRY_MAX_SECS: i64 = 7 \* 86_400;/);
    expect(VRF_EXPIRY_MAX_SECS).toBe(604_800);
    expect(rs).toMatch(/pub const DEFAULT_VRF_EXPIRY_SECS: i64 = 86_400;/);
    expect(VRF_EXPIRY_DEFAULT_SECS).toBe(86_400);
  });

  it("parses seconds and minutes", () => {
    expect(parseVrfExpiryInput("3600", "seconds")).toEqual({ ok: true, secs: 3600 });
    expect(parseVrfExpiryInput(" 3,600 ", "seconds")).toEqual({ ok: true, secs: 3600 });
    expect(parseVrfExpiryInput("60", "minutes")).toEqual({ ok: true, secs: 3600 });
    expect(parseVrfExpiryInput("1440", "minutes")).toEqual({ ok: true, secs: 86_400 });
    expect(parseVrfExpiryInput("86400", "seconds")).toEqual({ ok: true, secs: 86_400 });
    expect(parseVrfExpiryInput("604800", "seconds")).toEqual({ ok: true, secs: 604_800 });
    expect(parseVrfExpiryInput("10080", "minutes")).toEqual({ ok: true, secs: 604_800 });
  });

  it("rejects out-of-range and malformed input with a message", () => {
    const bad = (i: string, u: "seconds" | "minutes", re: RegExp) => {
      const r = parseVrfExpiryInput(i, u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(re);
    };
    bad("3599", "seconds", /minimum is 1 h/);
    bad("59", "minutes", /minimum is 1 h.*60–10080 minutes/);
    bad("604801", "seconds", /maximum is 7 days/);
    bad("10081", "minutes", /maximum is 7 days/);
    bad("", "seconds", /Enter a value/);
    bad("   ", "minutes", /Enter a value/);
    bad("60.5", "minutes", /whole number of minutes/);
    bad("-3600", "seconds", /whole number/);
    bad("1e4", "seconds", /whole number/);
    bad("abc", "seconds", /whole number/);
    bad("99999999999999999999", "seconds", /too large|maximum/);
    bad("0", "seconds", /minimum/);
  });

  it("formats durations for the UI", () => {
    expect(formatVrfExpiry(3600)).toBe("1 h");
    expect(formatVrfExpiry(86_400n)).toBe("24 h");
    expect(formatVrfExpiry(604_800)).toBe("7 days");
    expect(formatVrfExpiry(5_400)).toBe("90 min");
    expect(formatVrfExpiry(3_601)).toBe("3,601 s");
  });

  it("builds the same set_vrf_expiry instruction the CLI sends (admin signer + Config, i64 LE)", () => {
    const ix = buildSetVrfExpiryIxChecked({ authority: admin, expirySecs: 3600 });
    expect(ix.programId.equals(pid)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [admin.toBase58(), true, false],
      [deriveConfigPda(pid)[0].toBase58(), false, true],
    ]);
    const disc = createHash("sha256").update("global:set_vrf_expiry").digest().subarray(0, 8);
    expect(ix.data.subarray(0, 8).equals(disc)).toBe(true);
    expect(ix.data.subarray(0, 8).equals(IX_DISCRIMINATORS.set_vrf_expiry)).toBe(true);
    expect(ix.data.length).toBe(16);
    expect(ix.data.readBigInt64LE(8)).toBe(3600n);
    expect(ix.data.equals(buildSetVrfExpiryIx({ authority: admin, expirySecs: 3600n }).data)).toBe(true);
  });

  it("the checked builder refuses values the program would refuse", () => {
    expect(() => buildSetVrfExpiryIxChecked({ authority: admin, expirySecs: 3599 })).toThrow(RangeError);
    expect(() => buildSetVrfExpiryIxChecked({ authority: admin, expirySecs: 604_801 })).toThrow(RangeError);
    expect(() => buildSetVrfExpiryIxChecked({ authority: admin, expirySecs: 3600.5 })).toThrow(RangeError);
  });
});
