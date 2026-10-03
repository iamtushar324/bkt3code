import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import { providerTextColorClassName } from "./ProviderInstanceIcon";

describe("provider icon presentation", () => {
  it("uses known provider brand colors", () => {
    expect(providerTextColorClassName(ProviderDriverKind.make("codex"))).toBe(
      "text-black dark:text-white",
    );
    expect(providerTextColorClassName(ProviderDriverKind.make("claudeAgent"))).toBe(
      "text-[#d97757]",
    );
    expect(providerTextColorClassName(ProviderDriverKind.make("custom"))).toBeUndefined();
  });

  it("keeps deterministic initials for unknown providers", () => {
    expect(providerInstanceInitials("Ollama local")).toBe("OL");
    expect(providerInstanceInitials("custom-provider")).toBe("CP");
  });
});
