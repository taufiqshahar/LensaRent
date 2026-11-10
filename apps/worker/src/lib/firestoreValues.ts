/**
 * Converts between plain JavaScript values and the typed JSON the Firestore REST API uses
 * (https://firestore.googleapis.com/$discovery/rest?version=v1, schema `Value`).
 *
 * Rules that keep stored data predictable:
 *  - Numbers must be safe integers. Money is integer sen, and nothing else in the schema is
 *    fractional, so a float reaching this layer is always a bug and is rejected.
 *  - `Date` becomes a Firestore timestamp and comes back as a `Date`.
 *  - `undefined` map entries are skipped; `undefined` anywhere else is rejected.
 */
export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { referenceValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: FirestoreFields } };

export type FirestoreFields = Record<string, FirestoreValue>;
export type DocumentData = Record<string, unknown>;

export class FirestoreValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirestoreValueError";
  }
}

/** Sentinel: the field is set to the server's commit time. */
export class ServerTimestamp {
  readonly transform = "serverTimestamp";
}
/** Sentinel: the integer field is atomically increased by `by` (may be negative). */
export class Increment {
  constructor(readonly by: number) {
    if (!Number.isSafeInteger(by)) {
      throw new FirestoreValueError("increment must be a safe integer");
    }
  }
}

const SERVER_TIMESTAMP = new ServerTimestamp();
export function serverTimestamp(): ServerTimestamp {
  return SERVER_TIMESTAMP;
}
export function increment(by: number): Increment {
  return new Increment(by);
}

export type FieldTransform =
  | { fieldPath: string; setToServerValue: "REQUEST_TIME" }
  | { fieldPath: string; increment: FirestoreValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertFieldName(name: string): void {
  if (name === "" || /^__.*__$/.test(name)) {
    throw new FirestoreValueError("field names must be non-empty and not reserved");
  }
}

/** Quotes a field name for use in a field path (update masks, transforms, query filters). */
export function fieldPathSegment(name: string): string {
  assertFieldName(name);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return `\`${name.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

export function encodeValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  switch (typeof value) {
    case "boolean":
      return { booleanValue: value };
    case "string":
      return { stringValue: value };
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new FirestoreValueError("numbers must be safe integers (money is integer sen)");
      }
      // `-0` is a safe integer; store it as plain zero.
      return { integerValue: String(value === 0 ? 0 : value) };
    case "object":
      break;
    default:
      throw new FirestoreValueError(`cannot store a value of type ${typeof value}`);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new FirestoreValueError("cannot store an invalid Date");
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => encodeValue(item)) } };
  }
  if (value instanceof ServerTimestamp || value instanceof Increment) {
    throw new FirestoreValueError("transforms are only allowed as map fields, not inside arrays");
  }
  if (!isPlainObject(value)) {
    throw new FirestoreValueError("only plain objects, arrays, Dates and primitives can be stored");
  }
  // Reached only for maps nested inside arrays, where a transform has no addressable path.
  const transforms: FieldTransform[] = [];
  const fields = encodeMap(value, [], transforms);
  if (transforms.length > 0) {
    throw new FirestoreValueError("transforms are only allowed as map fields, not inside arrays");
  }
  return { mapValue: { fields } };
}

function encodeMap(
  data: Record<string, unknown>,
  parentPath: readonly string[],
  transforms: FieldTransform[],
): FirestoreFields {
  const fields: FirestoreFields = {};
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const path = [...parentPath, fieldPathSegment(name)];

    if (value instanceof ServerTimestamp) {
      transforms.push({ fieldPath: path.join("."), setToServerValue: "REQUEST_TIME" });
    } else if (value instanceof Increment) {
      transforms.push({ fieldPath: path.join("."), increment: encodeValue(value.by) });
    } else if (isPlainObject(value)) {
      fields[name] = { mapValue: { fields: encodeMap(value, path, transforms) } };
    } else {
      fields[name] = encodeValue(value);
    }
  }
  return fields;
}

export interface EncodedDocument {
  fields: FirestoreFields;
  /** Server-side transforms pulled out of the data (timestamps, increments). */
  transforms: FieldTransform[];
  /** Top-level field paths that carry a stored value; used as the mask for partial updates. */
  maskPaths: string[];
}

export function encodeDocument(data: DocumentData): EncodedDocument {
  if (!isPlainObject(data)) throw new FirestoreValueError("document data must be a plain object");
  const transforms: FieldTransform[] = [];
  const fields = encodeMap(data, [], transforms);
  return { fields, transforms, maskPaths: Object.keys(fields).map(fieldPathSegment) };
}

export function decodeValue(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("stringValue" in value) return value.stringValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("doubleValue" in value) return value.doubleValue;
  if ("integerValue" in value) {
    const parsed = Number(value.integerValue);
    if (!Number.isSafeInteger(parsed)) {
      throw new FirestoreValueError("stored integer is outside the safe integer range");
    }
    return parsed;
  }
  if ("timestampValue" in value) return new Date(value.timestampValue);
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields);
  throw new FirestoreValueError("stored value has an unsupported type");
}

export function decodeFields(fields: FirestoreFields | undefined): DocumentData {
  const data: DocumentData = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    data[name] = decodeValue(value);
  }
  return data;
}
