import { expect, test } from "bun:test";
import { checkSchema, validate } from "../src/schema.ts";
import type { Json, Schema } from "../src/types.ts";

test("schema constraints reject incorrect types, unexpected properties and out-of-range values", () => {
  const schema: Schema = { type: "object", properties: {
    count: { type: "integer", minimum: 1, maximum: 4 },
    tags: { type: "array", maxItems: 2, items: { type: "string", minLength: 1 } },
    mode: { type: "string", enum: ["fast", "safe"] },
  }, required: ["count", "mode"], additionalProperties: false };
  checkSchema(schema);
  validate(schema, { count: 2, mode: "safe", tags: ["a"] });
  for (const input of [null, { count: "2", mode: "safe" }, { count: 0, mode: "safe" },
    { count: 2, mode: "wrong" }, { count: 2, mode: "safe", unexpected: true },
    { count: 2, mode: "fast", tags: [""] }, { count: 2, mode: "fast", tags: ["a", "b", "c"] }] as Json[]) {
    expect(() => validate(schema, input)).toThrow();
  }
});

test("unsupported schema features and malformed numeric constraints fail at registration", () => {
  for (const schema of [{ type: "string", pattern: "a" }, { type: "integer", minimum: 5, maximum: 1 },
    { type: "array", maxItems: -1 }, { type: "string", minLength: 1.2 },
    { type: "number", maximum: Infinity }] as Schema[]) expect(() => checkSchema(schema)).toThrow();
});
