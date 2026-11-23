import type { Json, Schema } from "./types.ts";

const KEYS = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);

export function checkSchema(schema: Schema, depth = 0): void {
  if (depth > 32 || !schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Invalid tool schema");
  for (const key of Object.keys(schema)) if (!KEYS.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (schema.type && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) {
    throw new Error(`Unsupported schema type: ${schema.type}`);
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    const value = schema[key];
    if (value !== undefined && (!Number.isFinite(value) ||
      (!["minimum", "maximum"].includes(key) && (!Number.isSafeInteger(value) || value < 0)))) {
      throw new Error(`Invalid schema constraint: ${key}`);
    }
  }
  for (const [low, high] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]] as const) {
    if (schema[low] !== undefined && schema[high] !== undefined && schema[low]! > schema[high]!) throw new Error("Inverted schema constraint");
  }
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string"))) throw new Error("Invalid required fields");
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error("Invalid schema enum");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error("Unsupported additionalProperties");
  for (const child of Object.values(schema.properties ?? {})) checkSchema(child, depth + 1);
  if (schema.items) checkSchema(schema.items, depth + 1);
}

export function validate(schema: Schema, value: Json, path = "$", depth = 0): void {
  if (depth > 64) throw new Error("Tool arguments too deeply nested");
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path}: invalid enum value`);
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && (schema.type === "integer" ? !Number.isInteger(value) : type !== schema.type)) {
    throw new Error(`${path}: expected ${schema.type}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path}: number outside limits`);
  }
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) ||
    (schema.maxLength !== undefined && value.length > schema.maxLength))) throw new Error(`${path}: string outside limits`);
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new Error(`${path}: array outside limits`);
    if (schema.items) value.forEach((item, index) => validate(schema.items!, item, `${path}[${index}]`, depth + 1));
  } else if (value !== null && typeof value === "object") {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validate(schema.properties[key], item, `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unexpected property`);
    }
  }
}
