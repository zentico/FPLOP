import { describe, expect, it } from "vitest";
import { ffhImportOwnership } from "../ffh";

describe("FFH ownership import", () => {
  it("uses official FPL selection percentage instead of FFH effective ownership", () => {
    expect(ffhImportOwnership(127.722, 68.5)).toBe(68.5);
  });

  it("does not persist an invalid official percentage", () => {
    expect(ffhImportOwnership(127.722, undefined)).toBe(0);
    expect(ffhImportOwnership(50, 101)).toBe(0);
  });
});