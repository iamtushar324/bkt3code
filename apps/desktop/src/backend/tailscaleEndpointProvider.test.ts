import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import {
  parseTailscaleMagicDnsName,
  resolveTailscaleAdvertisedEndpoints,
} from "./tailscaleEndpointProvider.ts";

const layerUnusedTailscaleExternalServices = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected Tailscale HTTPS probe")),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected tailscale status process")),
  ),
);

describe("tailscale endpoint provider", () => {
  it.effect("parses MagicDNS names from tailscale status", () =>
    Effect.gen(function* () {
      const dnsName = yield* parseTailscaleMagicDnsName(
        `{"Self":{"DNSName":"desktop.tail.ts.net."}}`,
      );
      assert.equal(dnsName, "desktop.tail.ts.net");
      assert.equal(yield* parseTailscaleMagicDnsName("{}"), null);
      const malformed = yield* Effect.result(parseTailscaleMagicDnsName("not-json"));
      assert.isTrue(malformed._tag === "Failure");
    }),
  );

  it.effect("resolves Tailscale endpoints as add-on advertised endpoints", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        networkAccessEnabled: true,
        networkInterfaces: {
          tailscale0: [
            {
              address: "100.100.100.100",
              family: "IPv4",
              internal: false,
              netmask: "255.192.0.0",
              cidr: "100.100.100.100/10",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
        statusJson: `{"Self":{"DNSName":"desktop.tail.ts.net."}}`,
      });
      assert.deepEqual(endpoints, [
        {
          id: "tailscale-magicdns:http://desktop.tail.ts.net:3773",
          label: "Tailscale MagicDNS",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://desktop.tail.ts.net:3773/",
          wsBaseUrl: "ws://desktop.tail.ts.net:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
          description: "Reachable from devices on the same Tailnet without Tailscale Serve.",
        },
        {
          id: "tailscale-ip:http://100.100.100.100:3773",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.100.100.100:3773/",
          wsBaseUrl: "ws://100.100.100.100:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
          description: "Reachable from devices on the same Tailnet.",
        },
        {
          id: "tailscale-magicdns:https://desktop.tail.ts.net/",
          label: "Tailscale HTTPS",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "https://desktop.tail.ts.net/",
          wsBaseUrl: "wss://desktop.tail.ts.net/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "requires-configuration",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "unavailable",
          description: "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
        },
      ]);
    }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect("uses an injected magic DNS name reader instead of spawning tailscale", () =>
    Effect.gen(function* () {
      let readerCalls = 0;
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 3773,
        networkAccessEnabled: true,
        networkInterfaces: {},
        readMagicDnsName: Effect.sync(() => {
          readerCalls += 1;
          return "desktop.tail.ts.net";
        }),
      });
      assert.equal(readerCalls, 1);
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.httpBaseUrl),
        ["http://desktop.tail.ts.net:3773/", "https://desktop.tail.ts.net/"],
      );
    }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect(
    "marks the Tailscale HTTPS endpoint available after Serve is enabled and reachable",
    () =>
      Effect.gen(function* () {
        const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
          port: 3773,
          networkAccessEnabled: false,
          networkInterfaces: {},
          statusJson: `{"Self":{"DNSName":"desktop.tail.ts.net."}}`,
          serveEnabled: true,
          probe: () => Effect.succeed(true),
        });
        assert.deepEqual(endpoints, [
          {
            id: "tailscale-magicdns:https://desktop.tail.ts.net/",
            label: "Tailscale HTTPS",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "https://desktop.tail.ts.net/",
            wsBaseUrl: "wss://desktop.tail.ts.net/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "compatible",
              desktopApp: "compatible",
            },
            source: "desktop-addon",
            status: "available",
            description: "HTTPS endpoint served by Tailscale Serve.",
          },
        ]);
      }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );

  it.effect("does not advertise direct endpoints when network access is disabled", () =>
    Effect.gen(function* () {
      const endpoints = yield* resolveTailscaleAdvertisedEndpoints({
        port: 4780,
        networkAccessEnabled: false,
        networkInterfaces: {
          tailscale0: [{ address: "100.90.1.2", family: "IPv4", internal: false }],
        },
        statusJson: `{"Self":{"DNSName":"desktop.tail.ts.net."}}`,
      });
      assert.deepEqual(
        endpoints.map((endpoint) => [endpoint.httpBaseUrl, endpoint.status]),
        [["https://desktop.tail.ts.net/", "unavailable"]],
      );
    }).pipe(Effect.provide(layerUnusedTailscaleExternalServices)),
  );
});
