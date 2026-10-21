import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROGRAM_ERRORS, findProgramError, programErrorByCode } from "../src/errors";

/** Parse `enum GreenCatError` from the program source so CI catches drift. */
function parseEnum(): { name: string; msg: string }[] {
  const src = readFileSync(resolve(__dirname, "../../../programs/greencat/src/lib.rs"), "utf8");
  const start = src.indexOf("pub enum GreenCatError");
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/#\[msg\("((?:[^"\\]|\\.)*)"\)\]\s*\n\s*(\w+),/g)].map((m) => ({
    msg: m[1],
    name: m[2],
  }));
}

describe("program error table", () => {
  it("matches enum GreenCatError order and messages", () => {
    const parsed = parseEnum();
    expect(parsed.length).toBeGreaterThan(50);
    expect(PROGRAM_ERRORS.map((e) => e.name)).toEqual(parsed.map((p) => p.name));
    expect(PROGRAM_ERRORS.map((e) => e.msg)).toEqual(parsed.map((p) => p.msg));
    PROGRAM_ERRORS.forEach((e, i) => expect(e.code).toBe(6000 + i));
  });

  it("finds errors in wallet / simulation messages", () => {
    expect(findProgramError("failed: custom program error: 0x1771")?.name).toBe("Paused");
    expect(findProgramError("Program log: AnchorError ... Error Code: PriceMismatch. Error Number: 6052")?.name).toBe(
      "PriceMismatch",
    );
    expect(findProgramError('{"InstructionError":[0,{"Custom":6000}]}')?.name).toBe("Unauthorized");
    // SPL token "insufficient funds" (0x1) is not a GreenCat error.
    expect(findProgramError("custom program error: 0x1")).toBeUndefined();
    expect(programErrorByCode(6007)?.friendly).toMatch(/sold out/i);
  });
});

describe("account discriminators", async () => {
  it("Listing matches the program layout", async () => {
    const { LISTING_ACCOUNT_LEN } = await import("../src/accounts");
    expect(LISTING_ACCOUNT_LEN).toBe(82);
    const src = readFileSync(resolve(__dirname, "../../../programs/greencat/src/marketplace.rs"), "utf8");
    expect(src).toMatch(/impl Listing \{\s*pub const LEN: usize = 8 \+ 32 \+ 32 \+ 8 \+ 1 \+ 1;/);
  });
});
