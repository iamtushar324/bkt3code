// T3-CUSTOM(expbkt3): a default-model change keeps the saved effort and
// context options the new model understands.
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { carryModelOptionsToSelection } from "./NewThreadModeSettings.expbkt3";

const claude = ProviderInstanceId.make("claudeAgent");
const claudeWork = ProviderInstanceId.make("claudeAgent_work");
const codex = ProviderInstanceId.make("codex");

function model(
  slug: string,
  efforts: readonly string[],
  withContext: boolean,
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: efforts.map((id) => ({ id, label: id, isDefault: id === "high" })),
        },
        ...(withContext
          ? [
              {
                id: "contextWindow",
                label: "Context",
                type: "select" as const,
                options: [
                  { id: "200k", label: "200k", isDefault: true },
                  { id: "1m", label: "1m" },
                ],
              },
            ]
          : []),
      ],
    },
  };
}

const models = [
  model("claude-opus-5", ["low", "medium", "high", "max"], true),
  model("claude-sonnet-5", ["low", "medium", "high"], false),
];
const claudeEntry = { driverKind: ProviderDriverKind.make("claudeAgent"), models };
const previous = {
  instanceId: claude,
  model: "claude-opus-5",
  options: [
    { id: "effort", value: "max" },
    { id: "contextWindow", value: "1m" },
  ],
};

describe("carryModelOptionsToSelection", () => {
  it("keeps every option the new model offers", () => {
    const next = carryModelOptionsToSelection({
      previous,
      previousEntry: claudeEntry,
      instanceId: claude,
      model: "claude-opus-5",
      entry: claudeEntry,
      planModeAvailable: true,
    });
    expect(next).toEqual(previous);
  });

  it("drops a trait the new model lacks and resets a value it does not offer", () => {
    const next = carryModelOptionsToSelection({
      previous,
      previousEntry: claudeEntry,
      instanceId: claude,
      model: "claude-sonnet-5",
      entry: claudeEntry,
      planModeAvailable: true,
    });
    // "max" is not a sonnet effort: the pinned trait falls back to the model's
    // default; sonnet has no context-window trait at all, so it is dropped.
    expect(next).toEqual({
      instanceId: claude,
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("carries options to another instance of the same driver", () => {
    const next = carryModelOptionsToSelection({
      previous,
      previousEntry: claudeEntry,
      instanceId: claudeWork,
      model: "claude-opus-5",
      entry: claudeEntry,
      planModeAvailable: true,
    });
    expect(next.instanceId).toBe(claudeWork);
    expect(next.options).toEqual(previous.options);
  });

  it("starts clean on a different driver or without a previous selection", () => {
    const codexEntry = {
      driverKind: ProviderDriverKind.make("codex"),
      models: [model("gpt-6-astra", ["low", "high"], false)],
    };
    expect(
      carryModelOptionsToSelection({
        previous,
        previousEntry: claudeEntry,
        instanceId: codex,
        model: "gpt-6-astra",
        entry: codexEntry,
        planModeAvailable: true,
      }),
    ).toEqual({ instanceId: codex, model: "gpt-6-astra" });
    expect(
      carryModelOptionsToSelection({
        previous: null,
        previousEntry: undefined,
        instanceId: claude,
        model: "claude-opus-5",
        entry: claudeEntry,
        planModeAvailable: true,
      }),
    ).toEqual({ instanceId: claude, model: "claude-opus-5" });
  });
});
