import {
  PrimaryConnectionTarget,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { buildRemoteOpenUrl, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRemoteOpenState } from "../remoteOpen";
import { desktopManagesPrimaryBackend } from "./remoteOpenManaged";

const environmentId = EnvironmentId.make("environment-1");

/** The managed desktop's primary: the central fork server, not this machine. */
const managedPrimary = new PrimaryConnectionTarget({
  environmentId,
  label: "bkt3",
  httpBaseUrl: "https://bkt3.dev.beknown.live",
  wsBaseUrl: "wss://bkt3.dev.beknown.live",
});

/** What dev-server-1 advertises: tailnet name first, and its own login account. */
const DS1_TARGETS = [
  { kind: "tailscale", host: "dev-server-1.tailab6257.ts.net", username: "ubuntu" },
  { kind: "mdns", host: "dev-server-1.local", username: "ubuntu" },
] as const;

describe("desktopManagesPrimaryBackend", () => {
  it("is true for an upstream desktop build, which hosts its own primary", () => {
    expect(desktopManagesPrimaryBackend({ hasDesktopBridge: true, isManagedPrimary: false })).toBe(
      true,
    );
  });

  it("is false for a managed build, whose primary is a central server", () => {
    expect(desktopManagesPrimaryBackend({ hasDesktopBridge: true, isManagedPrimary: true })).toBe(
      false,
    );
  });

  it("is false in a browser regardless of the primary", () => {
    for (const isManagedPrimary of [false, true]) {
      expect(desktopManagesPrimaryBackend({ hasDesktopBridge: false, isManagedPrimary })).toBe(
        false,
      );
    }
  });
});

describe("managed desktop remote open", () => {
  it("uses deep links for the managed central primary instead of exec'ing on the server", () => {
    // The regression this fixes: with `isDesktopRenderer: true` the resolver
    // returned local-exec, so the desktop asked dev-server-1 to launch an
    // editor there and nothing opened on the viewer's machine.
    expect(
      resolveRemoteOpenState({
        target: managedPrimary,
        sshTarget: null,
        remoteOpenTargets: DS1_TARGETS,
        isDesktopRenderer: desktopManagesPrimaryBackend({
          hasDesktopBridge: true,
          isManagedPrimary: true,
        }),
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "tailscale", host: "dev-server-1.tailab6257.ts.net", username: "ubuntu" },
    });
  });

  it("keeps exec behavior for the bundled local backend in the same build", () => {
    expect(
      resolveRemoteOpenState({
        target: new BearerConnectionTarget({
          environmentId,
          label: "This Mac",
          connectionId: "local:bk-local",
        }),
        sshTarget: null,
        remoteOpenTargets: DS1_TARGETS,
        isDesktopRenderer: desktopManagesPrimaryBackend({
          hasDesktopBridge: true,
          isManagedPrimary: true,
        }),
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("carries each host's own login account into the deep link", () => {
    // Two hosts, two accounts, one client: the URL must follow the host.
    const ds1 = resolveRemoteOpenState({
      target: managedPrimary,
      sshTarget: null,
      remoteOpenTargets: DS1_TARGETS,
      isDesktopRenderer: false,
    });
    const otherHost = resolveRemoteOpenState({
      target: managedPrimary,
      sshTarget: null,
      remoteOpenTargets: [
        { kind: "tailscale", host: "mini.tailab6257.ts.net", username: "tushar" },
      ],
      isDesktopRenderer: false,
    });

    if (ds1.mode !== "remote-links" || otherHost.mode !== "remote-links") {
      throw new Error("expected remote-links for both hosts");
    }

    expect(
      buildRemoteOpenUrl({
        editor: "cursor",
        host: ds1.host.host,
        ...(ds1.host.username === undefined ? {} : { username: ds1.host.username }),
        absolutePath: "/home/ubuntu/.t3/bkt3-dev/worktrees/t3code-bkmain/biryani",
      }),
    ).toBe(
      "cursor://vscode-remote/ssh-remote+ubuntu%40dev-server-1.tailab6257.ts.net" +
        "/home/ubuntu/.t3/bkt3-dev/worktrees/t3code-bkmain/biryani",
    );

    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: otherHost.host.host,
        ...(otherHost.host.username === undefined ? {} : { username: otherHost.host.username }),
        absolutePath: "/Users/tushar/code",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+tushar%40mini.tailab6257.ts.net/Users/tushar/code");
  });

  it("still builds a link against a server that advertises no username", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol.tail1234.ts.net",
        absolutePath: "/srv/work",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol.tail1234.ts.net/srv/work");
  });
});
