import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeAI, CursorIcon, GrokIcon, OpenAI, OpenCodeIcon } from "../Icons";
import { providerInstanceInitials } from "./ProviderInstanceIcon";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider icon presentation", () => {
  it("maps built-in providers to their company icons", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("codex")]).toBe(OpenAI);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")]).toBe(ClaudeAI);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("opencode")]).toBe(OpenCodeIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("cursor")]).toBe(CursorIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("grok")]).toBe(GrokIcon);
  });

  it("keeps deterministic initials for unknown providers", () => {
    expect(providerInstanceInitials("Ollama local")).toBe("OL");
    expect(providerInstanceInitials("custom-provider")).toBe("CP");
  });
});
