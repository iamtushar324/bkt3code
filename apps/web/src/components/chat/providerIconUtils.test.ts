// T3-CUSTOM(expbkt3): the fork's provider icon presentation tests (below) need these.
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

// T3-CUSTOM(expbkt3): provider icon presentation tests.
import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import { getDisplayModelName, getProviderRowLabel } from "./providerIconUtils";
// T3-CUSTOM(expbkt3): upstream renamed providerTextColorClassName to providerTextColor.
import { providerTextColor } from "./ProviderInstanceIcon";

// T3-CUSTOM(expbkt3): BEGIN — provider icon presentation.
describe("provider icon presentation", () => {
  it("uses known provider brand colors", () => {
    expect(providerTextColor(ProviderDriverKind.make("codex")).className).toBe(
      "text-black dark:text-white",
    );
    expect(providerTextColor(ProviderDriverKind.make("claudeAgent")).className).toBe(
      "text-[#d97757]",
    );
    expect(providerTextColor(ProviderDriverKind.make("custom")).className).toBeUndefined();
  });

  it("keeps deterministic initials for unknown providers", () => {
    expect(providerInstanceInitials("Ollama local")).toBe("OL");
    expect(providerInstanceInitials("custom-provider")).toBe("CP");
  });
});
// T3-CUSTOM(expbkt3): END

describe("getProviderRowLabel", () => {
  it("shows a sub-provider named after its provider on its own", () => {
    expect(getProviderRowLabel("OpenCode", "OpenCode Zen")).toBe("OpenCode Zen");
    expect(getProviderRowLabel("OpenCode", "OpenCode Go")).toBe("OpenCode Go");
  });

  it("keeps a provider id that merely starts like the provider name", () => {
    expect(getProviderRowLabel("OpenCode", "opencode-go")).toBe("OpenCode · opencode-go");
  });

  it("joins a sub-provider that names something else", () => {
    expect(getProviderRowLabel("OpenCode", "GitHub Copilot")).toBe("OpenCode · GitHub Copilot");
  });

  it("keeps the provider name when a model has no sub-provider", () => {
    expect(getProviderRowLabel("Claude", undefined)).toBe("Claude");
  });
});

describe("getDisplayModelName", () => {
  it("drops a leading sub-provider qualifier from the model name", () => {
    expect(
      getDisplayModelName({
        slug: "a/b",
        name: "OpenCode Zen: Step 5",
        subProvider: "OpenCode Zen",
      }),
    ).toBe("Step 5");
  });
});
