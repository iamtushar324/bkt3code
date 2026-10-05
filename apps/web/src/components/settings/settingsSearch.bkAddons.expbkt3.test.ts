/** T3-CUSTOM(expbkt3): renamed settings stay reachable by old and new names. */
import { expect, it } from "vite-plus/test";
import { searchSettings, SETTINGS_SECTION_LABELS } from "./settingsSearch";

it("keeps the existing settings route with the new visible label", () => {
  expect(SETTINGS_SECTION_LABELS["/settings/experiments"]).toBe("BK Add-ons");
});

it.each(["experiments", "BK Add-ons", "Toolyard", "account consent"])(
  "finds the connection controls for %s",
  (query) => {
    expect(searchSettings(query)).toContainEqual(
      expect.objectContaining({ id: "toolyard", to: "/settings/experiments" }),
    );
  },
);

it.each(["callbacks", "webhook", "delivery history", "experiments"])(
  "finds session delivery details for %s",
  (query) => {
    expect(searchSettings(query)).toContainEqual(
      expect.objectContaining({ id: "session-webhooks", to: "/settings/experiments" }),
    );
  },
);

it.each(["native-plan-review", "chat-comments", "agent-ui-surfaces"])(
  "keeps %s discoverable by the old section name",
  (id) => {
    expect(searchSettings("experiments")).toContainEqual(expect.objectContaining({ id }));
  },
);
