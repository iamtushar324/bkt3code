import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { modelSelectionFor, resolveModel } from "./models.ts";

const model = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
  ...extra,
});

// Only the catalog fields the resolver reads.
const provider = (instanceId: string, driver: string, models: ReadonlyArray<unknown>) =>
  ({ instanceId, driver, enabled: true, installed: true, models }) as unknown as ServerProvider;

const providers = [
  provider("claudeAgent", "claudeAgent", [
    model("claude-sonnet-5-5", "Claude Sonnet 5.5", { isDefault: true }),
    model("claude-opus-5-5", "Claude Opus 5.5", {
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    }),
  ]),
  provider("codex", "codex", [model("gpt-6-codex", "GPT-6 Codex", { isDefault: true })]),
];

const resolved = (ref: string) => {
  const result = resolveModel(ref, providers);
  if (Result.isFailure(result)) throw new Error(result.failure);
  return `${result.success.provider.instanceId}/${result.success.model.slug}`;
};

describe("resolveModel", () => {
  it("resolves family aliases, exact slugs and provider/model names", () => {
    expect(resolved("opus")).toBe("claudeAgent/claude-opus-5-5");
    expect(resolved("sonnet")).toBe("claudeAgent/claude-sonnet-5-5");
    expect(resolved("codex")).toBe("codex/gpt-6-codex");
    expect(resolved("claude-opus-5-5")).toBe("claudeAgent/claude-opus-5-5");
    expect(resolved("codex/gpt-6-codex")).toBe("codex/gpt-6-codex");
  });

  it("refuses an unknown model and lists the real ones", () => {
    const result = resolveModel("gemini", providers);
    expect(Result.isFailure(result) && result.failure).toContain("claudeAgent/claude-sonnet-5-5");
  });

  it("sets effort through the model's own effort option", () => {
    const opus = resolveModel("opus", providers);
    if (Result.isFailure(opus)) throw new Error(opus.failure);
    const selection = modelSelectionFor(opus.success, "High");
    expect(Result.isSuccess(selection) && selection.success).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(Result.isFailure(modelSelectionFor(opus.success, "max"))).toBe(true);
  });
});
