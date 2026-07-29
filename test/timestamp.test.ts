import assert from "node:assert/strict";
import test from "node:test";
import { formatTimestamp } from "../src/timestamp.js";

test("formats second, millisecond, and string timestamps in an IANA timezone", () => {
  const expected = "2024-01-01T08:00:00.000+08:00";

  assert.equal(formatTimestamp(1_704_067_200, "Asia/Shanghai"), expected);
  assert.equal(
    formatTimestamp(1_704_067_200_000, "Asia/Shanghai"),
    expected,
  );
  assert.equal(
    formatTimestamp("2024-01-01T00:00:00Z", "Asia/Shanghai"),
    expected,
  );
});

test("preserves the existing UTC ISO representation by default", () => {
  assert.equal(
    formatTimestamp("2024-01-01T00:00:00Z", "UTC"),
    "2024-01-01T00:00:00.000Z",
  );
});

test("uses the offset in effect at each timestamp", () => {
  assert.equal(
    formatTimestamp("2024-01-01T00:00:00Z", "America/New_York"),
    "2023-12-31T19:00:00.000-05:00",
  );
  assert.equal(
    formatTimestamp("2024-07-01T00:00:00Z", "America/New_York"),
    "2024-06-30T20:00:00.000-04:00",
  );
});

test("returns null for missing or invalid timestamps", () => {
  assert.equal(formatTimestamp(null, "UTC"), null);
  assert.equal(formatTimestamp(Number.NaN, "UTC"), null);
  assert.equal(formatTimestamp("not-a-timestamp", "UTC"), null);
});
