import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

// T3-CUSTOM(expbkt3): managed desktop builds surface the bundled backend as an
// ordinary secondary bootstrap; only the primary id stays filtered.
import {
  __resetBkManagedEnvironmentForTests,
  __setBkManagedEnvironmentForTests,
} from "../fork/managedEnvironment";

import {
  createDesktopSecondaryBootstrapsReader,
  desktopLocalBackendId,
  desktopLocalConnectionId,
  isDesktopLocalConnectionTarget,
  isWslConnectionTarget,
} from "./desktopLocal";

describe("desktop local connection identity", () => {
  it("preserves the desktop backend instance id", () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      environmentId: EnvironmentId.make("environment-wsl"),
      label: "WSL (Ubuntu)",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(true);
    expect(desktopLocalBackendId(target)).toBe("wsl:Ubuntu");
    expect(isWslConnectionTarget(target)).toBe(true);
  });

  it("does not infer WSL for another desktop-local backend", () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("native-linux"),
      environmentId: EnvironmentId.make("environment-native-linux"),
      label: "Linux",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(true);
    expect(isWslConnectionTarget(target)).toBe(false);
  });

  it("does not classify the primary environment as desktop-local", () => {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-primary"),
      httpBaseUrl: "http://127.0.0.1:3773",
      label: "This device",
      wsBaseUrl: "ws://127.0.0.1:3773",
    });

    expect(isDesktopLocalConnectionTarget(target)).toBe(false);
    expect(desktopLocalBackendId(target)).toBeNull();
  });
});

describe("desktop local topology reads", () => {
  afterEach(() => {
    __resetBkManagedEnvironmentForTests();
  });

  it("distinguishes a successful empty topology from a read failure", () => {
    let readBootstraps = () => [];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [] });

    const cause = new Error("IPC unavailable");
    readBootstraps = () => {
      throw cause;
    };
    expect(reader.readResult()).toEqual({ _tag: "Failure", cause });
  });

  it("filters the primary bootstrap from successful topology reads", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };

    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [
        {
          ...secondary,
          id: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Windows",
        },
        secondary,
      ],
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [secondary] });
  });

  // T3-CUSTOM(expbkt3): a managed build carries the bundled backend as the
  // "bk-local" secondary; only the pool-primary id (a client-only legacy
  // leftover) stays filtered.
  it("surfaces the bundled backend in a managed build while filtering the primary id", () => {
    __setBkManagedEnvironmentForTests({
      channel: "staging",
      httpBaseUrl: "https://expbkt3.dev.beknown.live",
      wsBaseUrl: "wss://expbkt3.dev.beknown.live",
    });
    const bundled = {
      id: "bk-local",
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "token",
    };
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => [
        {
          id: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Legacy local backend",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        },
        bundled,
      ],
    }));

    expect(reader.readResult()).toEqual({ _tag: "Success", bootstraps: [bundled] });
  });

  it("retains the last successful snapshot only until another read succeeds", () => {
    const secondary = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
    };
    let readBootstraps = () => [secondary];
    const reader = createDesktopSecondaryBootstrapsReader(() => ({
      getLocalEnvironmentBootstraps: () => readBootstraps(),
    }));

    const connectedSnapshot = reader.readSnapshot();
    expect(connectedSnapshot).toEqual([secondary]);

    readBootstraps = () => {
      throw new Error("IPC unavailable");
    };
    expect(reader.readSnapshot()).toBe(connectedSnapshot);

    readBootstraps = () => [];
    const removedSnapshot = reader.readSnapshot();
    expect(removedSnapshot).toEqual([]);

    readBootstraps = () => {
      throw new Error("IPC unavailable again");
    };
    expect(reader.readSnapshot()).toBe(removedSnapshot);
  });
});
