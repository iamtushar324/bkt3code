// T3-CUSTOM(expbkt3): session lineage tool surface.
//
// These assertions guard the agent-facing contract rather than the plumbing:
// the two verbs must exist, take the ids they claim to, and — because a tool
// description is the only guidance a calling model gets — actually say when to
// reach for them.
import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { T3ControlToolkit } from "./tools.ts";

const jsonSchema = (name: "t3_link_session" | "t3_unlink_session" | "t3_create_session") =>
  Tool.getJsonSchema(T3ControlToolkit.tools[name]) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

/**
 * An optional field is emitted as `anyOf: [{...description}, {type: "null"}]`,
 * so the description a model actually reads is not at the top level.
 */
const describedText = (schema: unknown): string => {
  if (!schema || typeof schema !== "object") return "";
  const record = schema as Record<string, unknown>;
  const own = typeof record.description === "string" ? record.description : "";
  const nested = [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .flatMap((members) => members.map(describedText));
  return [own, ...nested].filter(Boolean).join(" ");
};

it("exposes link and unlink as separate verbs", () => {
  // Deliberately two tools rather than one nullable field: an agent
  // reorganising a workspace must be able to reach "detach" without emitting a
  // literal null.
  expect(T3ControlToolkit.tools.t3_link_session).toBeDefined();
  expect(T3ControlToolkit.tools.t3_unlink_session).toBeDefined();
});

it("requires both ids to link and only the subject to unlink", () => {
  const link = jsonSchema("t3_link_session");
  // T3-CUSTOM(expbkt3): the parent's environment is optional — omitting it means
  // "this one", which is how every same-machine link is expressed.
  expect(Object.keys(link.properties ?? {}).toSorted()).toEqual([
    "parentEnvironmentId",
    "parentSessionId",
    "sessionId",
  ]);
  expect(link.required?.toSorted()).toEqual(["parentSessionId", "sessionId"]);

  const unlink = jsonSchema("t3_unlink_session");
  expect(Object.keys(unlink.properties ?? {})).toEqual(["sessionId"]);
  expect(unlink.required).toEqual(["sessionId"]);
});

it("warns the caller that lineage must stay a tree", () => {
  expect(T3ControlToolkit.tools.t3_link_session.description).toMatch(/descendant/i);
});

it("tells the caller that unlinking keeps the subtree intact", () => {
  // Otherwise an agent may assume detaching a parent orphans its children.
  expect(T3ControlToolkit.tools.t3_unlink_session.description).toMatch(/child/i);
});

it("offers createAsChild and parentSessionId when creating a session", () => {
  const create = jsonSchema("t3_create_session");
  const properties = create.properties ?? {};
  expect(properties.createAsChild).toBeDefined();
  expect(properties.parentSessionId).toBeDefined();
  // Nesting is the default, so neither may be required.
  expect(create.required ?? []).not.toContain("createAsChild");
  expect(create.required ?? []).not.toContain("parentSessionId");
});

it("states the default and the reason to override it on createAsChild", () => {
  const description = describedText(jsonSchema("t3_create_session").properties?.createAsChild);
  expect(description).toMatch(/default/i);
  expect(description).toMatch(/false/);
});
