// T3-CUSTOM(expbkt3): which environment counts as "this computer" for the "local" default.
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "../connection/desktopLocal";
import { isThisComputerEnvironment } from "./localEnvironmentAppearance";

const primary = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-primary"),
  httpBaseUrl: "http://127.0.0.1:3773",
  label: "This device",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const bundled = new BearerConnectionTarget({
  connectionId: desktopLocalConnectionId("bundled"),
  environmentId: EnvironmentId.make("environment-bundled"),
  label: "Local",
});
const wsl = new BearerConnectionTarget({
  connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
  environmentId: EnvironmentId.make("environment-wsl"),
  label: "WSL (Ubuntu)",
});
const remote = new BearerConnectionTarget({
  connectionId: "saved-remote",
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Dev server",
});

describe("isThisComputerEnvironment", () => {
  it("is the primary in an upstream desktop build", () => {
    const context = { hasDesktopBridge: true, managedPrimary: false };
    expect(isThisComputerEnvironment(primary, context)).toBe(true);
    expect(isThisComputerEnvironment(remote, context)).toBe(false);
  });

  it("is the bundled local backend, not the central primary, in a managed build", () => {
    const context = { hasDesktopBridge: true, managedPrimary: true };
    expect(isThisComputerEnvironment(primary, context)).toBe(false);
    expect(isThisComputerEnvironment(bundled, context)).toBe(true);
  });

  it("leaves WSL backends and browser tabs alone", () => {
    expect(isThisComputerEnvironment(wsl, { hasDesktopBridge: true, managedPrimary: false })).toBe(
      false,
    );
    expect(
      isThisComputerEnvironment(primary, { hasDesktopBridge: false, managedPrimary: false }),
    ).toBe(false);
  });
});
