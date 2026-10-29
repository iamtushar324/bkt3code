/**
 * T3-CUSTOM(expbkt3): an error for a wrong t3_dispatch_command input that says
 * exactly what to send (TEC-1819).
 *
 * Decoding against the whole OrchestrationCommand union gives an error that
 * lists every literal `type` and hides what was wrong with the one the agent
 * meant. This reads `command.type` first: a known type is decoded against its
 * own member, and the error names that type, its required fields and a minimal
 * example; an unknown type gets the closest valid one. Lifecycle commands also
 * point to t3_session_action, which builds them for the agent.
 */
import { OrchestrationCommand as OrchestrationCommandSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

type JsonObject = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The t3_session_action that builds each lifecycle command. */
const SESSION_ACTION_FOR_TYPE: Readonly<Record<string, string>> = {
  "thread.archive": "archive",
  "thread.unarchive": "unarchive",
  "thread.delete": "delete",
  "thread.session.stop": "stop",
  "thread.session.restart": "restart",
  "thread.turn.interrupt": "interrupt",
  "thread.settle": "settle",
  "thread.unsettle": "activate",
  "thread.snooze": "snooze",
  "thread.unsnooze": "unsnooze",
};

/** Walks nested unions to the struct members, keyed by their `type` literal. */
const collectMembers = (schema: unknown, out: Map<string, Schema.Top>): void => {
  if (schema === null || (typeof schema !== "object" && typeof schema !== "function")) return;
  const members = (schema as { readonly members?: unknown }).members;
  if (Array.isArray(members)) {
    for (const member of members) collectMembers(member, out);
    return;
  }
  const fields = (schema as { readonly fields?: unknown }).fields;
  if (!isObject(fields)) return;
  const typeField = fields.type as
    | { readonly literal?: unknown; readonly literals?: unknown }
    | undefined;
  const literals =
    typeof typeField?.literal === "string"
      ? [typeField.literal]
      : Array.isArray(typeField?.literals)
        ? typeField.literals.filter((value): value is string => typeof value === "string")
        : [];
  for (const literal of literals) {
    if (!out.has(literal)) out.set(literal, schema as Schema.Top);
  }
};

let membersCache: ReadonlyMap<string, Schema.Top> | undefined;

/** Every command `type` t3_dispatch_command accepts, with its own schema. */
export const orchestrationCommandMembers = (): ReadonlyMap<string, Schema.Top> => {
  if (membersCache === undefined) {
    const out = new Map<string, Schema.Top>();
    collectMembers(OrchestrationCommandSchema, out);
    membersCache = out;
  }
  return membersCache;
};

const levenshtein = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
};

/** The valid names nearest to `input`, best first. */
export const closestNames = (
  input: string,
  names: Iterable<string>,
  count = 3,
): ReadonlyArray<string> => {
  const lower = input.toLowerCase();
  return [...names]
    .map((name) => {
      const candidate = name.toLowerCase();
      const contains = candidate.includes(lower) || lower.includes(candidate);
      return { name, score: levenshtein(lower, candidate) - (contains ? 3 : 0) };
    })
    .toSorted((left, right) => left.score - right.score || left.name.localeCompare(right.name))
    .slice(0, count)
    .map(({ name }) => name);
};

const resolveRef = (node: unknown, defs: JsonObject): JsonObject | undefined => {
  if (!isObject(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    return resolveRef(defs[ref.slice("#/$defs/".length)], defs);
  }
  return node;
};

const exampleValue = (name: string, node: unknown, defs: JsonObject, depth = 0): unknown => {
  if (name === "commandId") return "mcp:<unique-id>";
  if (name === "createdAt" || name.endsWith("At")) return "<ISO-8601 time>";
  const schema = resolveRef(node, defs);
  if (schema === undefined || depth > 4) return `<${name}>`;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (branches !== undefined) {
    const branch = branches.find((item) => resolveRef(item, defs)?.type !== "null");
    return exampleValue(name, branch, defs, depth + 1);
  }
  switch (schema.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return `<${name}>`;
  }
};

interface CommandShape {
  readonly type: string;
  readonly requiredFields: ReadonlyArray<string>;
  readonly example: JsonObject;
}

/** The required fields and a minimal example of one command type. */
export const commandShape = (type: string): CommandShape | undefined => {
  const member = orchestrationCommandMembers().get(type);
  if (member === undefined) return undefined;
  const root = Tool.getJsonSchemaFromSchema(member) as unknown;
  const defs = isObject(root) && isObject(root.$defs) ? root.$defs : {};
  const schema = resolveRef(root, defs) ?? {};
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((field): field is string => typeof field === "string")
    : [];
  const requiredFields = ["type", ...required.filter((field) => field !== "type")];
  const example: Record<string, unknown> = { type };
  for (const field of requiredFields) {
    if (field === "type") continue;
    example[field] = exampleValue(field, properties[field], defs);
  }
  return { type, requiredFields, example };
};

const sessionActionHint = (type: string): string | undefined => {
  const action = SESSION_ACTION_FOR_TYPE[type];
  return action === undefined
    ? undefined
    : `Use t3_session_action action=${action} instead; it builds this command for you${action === "archive" || action === "unarchive" ? " and is safe to retry" : ""}.`;
};

const decodeIssue = (member: Schema.Top, command: unknown): string | undefined => {
  const codec = member as unknown as Schema.Codec<unknown, unknown, never, never>;
  try {
    Schema.decodeUnknownSync(codec)(command);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const validTypesLine = (types: ReadonlyArray<string>) =>
  `Valid types: ${types.toSorted().join(", ")}.`;

/**
 * The message for a t3_dispatch_command input that did not decode.
 * `fallback` is the union decoder's own message, used only when the input
 * names a known type that nonetheless decodes on its own.
 */
export const describeCommandDecodeFailure = (command: unknown, fallback: string): string => {
  const members = orchestrationCommandMembers();
  const types = [...members.keys()];
  if (!isObject(command)) {
    return [
      'command must be a JSON object with a string `type`, for example {"type":"thread.archive","commandId":"mcp:<unique-id>","threadId":"<threadId>"}.',
      "For archive, unarchive, delete, stop or snooze, use t3_session_action instead.",
      validTypesLine(types),
    ].join("\n");
  }
  const type = command.type;
  if (typeof type !== "string" || type.trim().length === 0) {
    return [
      "command.type is missing. Set it to one command type.",
      "For archive, unarchive, delete, stop or snooze, use t3_session_action instead.",
      validTypesLine(types),
    ].join("\n");
  }
  const member = members.get(type);
  if (member === undefined) {
    const closest = closestNames(type, types);
    const hint = closest[0] === undefined ? undefined : sessionActionHint(closest[0]);
    return [
      `Unknown command type "${type}".${closest.length > 0 ? ` Did you mean "${closest[0]}"?` : ""}`,
      ...(hint === undefined ? [] : [hint]),
      validTypesLine(types),
    ].join("\n");
  }
  const shape = commandShape(type);
  const issue = decodeIssue(member, command);
  const hint = sessionActionHint(type);
  return [
    `Invalid ${type} command.${issue === undefined ? ` ${fallback}` : ""}`,
    ...(issue === undefined ? [] : [`Problem: ${issue}`]),
    ...(shape === undefined
      ? []
      : [
          `Required fields: ${shape.requiredFields.join(", ")}.`,
          `Example: ${JSON.stringify(shape.example)}`,
          "commandId is any new unique string you choose for this command.",
        ]),
    ...(hint === undefined ? [] : [hint]),
  ].join("\n");
};
