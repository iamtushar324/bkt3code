/** T3-CUSTOM(expbkt3): The plan tool experiment must be reachable through settings search. */
import { expect, it } from "vite-plus/test";

import { searchSettings } from "./settingsSearch";

it.each(["plan submission", "t3_submit_plan", "plannotator submit"])(
  "finds the server plan tool experiment for %s",
  (query) => {
    expect(searchSettings(query)).toContainEqual(
      expect.objectContaining({
        id: "plan-submission-tool",
        title: "Plan submission tool",
        to: "/settings/experiments",
      }),
    );
  },
);
