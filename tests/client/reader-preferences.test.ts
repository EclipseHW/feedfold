import { describe, expect, it } from "vitest";
import { resolveTheme } from "../../src/client/reader-preferences.js";

describe("theme preference", () => {
  it("follows the device appearance in auto mode", () => {
    expect(resolveTheme("auto", true)).toBe("light");
    expect(resolveTheme("auto", false)).toBe("dark");
  });

  it("keeps an explicit appearance regardless of the device", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
  });
});
