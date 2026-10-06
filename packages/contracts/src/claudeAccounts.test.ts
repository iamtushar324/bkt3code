import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerSettings } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("experimental.claudeAccountProfiles", () => {
  it("is on for a server with no saved value", () => {
    expect(decodeServerSettings({}).experimental.claudeAccountProfiles.enabled).toBe(true);
  });

  it("stays off when a server saved it off", () => {
    const decoded = decodeServerSettings({
      experimental: { claudeAccountProfiles: { enabled: false } },
    });
    expect(decoded.experimental.claudeAccountProfiles.enabled).toBe(false);
  });
});
