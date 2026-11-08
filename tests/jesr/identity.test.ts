import { describe, expect, it } from "vitest";
import { normalizeJesrId } from "../../lib/jesr/identity";

describe("Jesr identity normalization", () => {
  it("normalizes valid Crockford IDs to the canonical grouped form", () => {
    expect(normalizeJesrId(" jesr_0123_4567_89ab_cdef_ghjk_mnpq ")).toBe(
      "JESR-0123-4567-89AB-CDEF-GHJK-MNPQ",
    );
  });

  it("rejects a mesh node UUID when a Jesr account ID is required", () => {
    expect(normalizeJesrId("123e4567-e89b-12d3-a456-426614174000")).toBeNull();
  });

  it("rejects letters excluded from the Crockford alphabet", () => {
    expect(normalizeJesrId("JESR-0123-4567-89AB-CDEF-GHIJ-MNPQ")).toBeNull();
  });
});
