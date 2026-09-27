/**
 * Fork-owned bootstrap for managed BK desktop distributions.
 *
 * A managed build is an Electron client for the central BK environment that
 * also carries the bundled T3 backend. The renderer is served from the
 * packaged client assets and keeps the central server as its primary
 * environment; the bundled backend registers in the desktop backend pool as a
 * *secondary* local environment — the same rails a parallel WSL backend rides
 * — so agents can run on this machine, including with no network at all.
 *
 * The bundled backend never owns the window: readiness, protocol target and
 * the renderer's primary connection all stay on the managed central server.
 * That is why the instance is registered under its own id rather than as the
 * pool primary, and why it passes no onReady/onShutdown window hooks.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppActivation from "../app/DesktopAppActivation.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopClerk from "../app/DesktopClerk.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  BK_BUNDLED_BACKEND_ID,
  readBkManagedEnvironment,
  resolveBkClientRendererSource,
} from "./BkManagedEnvironment.ts";
import { resolveBkBundledBackendPort } from "./BkBundledBackendRuntime.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("bk-managed-bootstrap");

/** The bundled backend's pool id, branded for the pool registry. */
export const BK_BUNDLED_BACKEND_INSTANCE_ID: DesktopBackendPool.BackendInstanceId =
  DesktopBackendPool.BackendInstanceId(BK_BUNDLED_BACKEND_ID);

/**
 * Bring up the bundled local backend as a secondary pool instance.
 *
 * Failures are logged, never fatal: the managed client must keep working as a
 * pure client when the local backend cannot start (occupied ports, a broken
 * install). The renderer shows the instance through the desktop bootstrap
 * topology once it reports a config, exactly like a WSL secondary.
 */
const startBkBundledBackend = (channel: "staging" | "production") =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
      yield* logInfo("skipping bundled backend in development without a configured port");
      return;
    }
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const state = yield* DesktopState.DesktopState;

    const selection = yield* resolveBkBundledBackendPort({
      channel,
      configuredPort: environment.configuredBackendPort,
    });
    // resolvePrimary reads its port, bind host and exposure mode from
    // DesktopServerExposure, so configure it before the first start cycle.
    yield* serverExposure.configureFromSettings({ port: selection.port });
    if (yield* Ref.get(state.quitting)) {
      return;
    }
    const instance = yield* pool.register({
      id: BK_BUNDLED_BACKEND_INSTANCE_ID,
      label: configuration.resolvePrimaryLabel,
      configResolve: configuration.resolvePrimary,
    });
    yield* instance.start;
    yield* logInfo("bundled local backend starting", {
      port: selection.port,
      selectedByScan: selection.selectedByScan,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("bundled local backend failed to start; continuing as client-only", {
        cause: Cause.pretty(cause),
      }),
    ),
    Effect.withSpan("desktop.bootstrap.bkBundledBackend"),
  );

/** Returns true when this managed bootstrap handled desktop startup. */
export const bootstrapBkManagedDesktop = () =>
  Effect.gen(function* () {
    const managedEnvironment = readBkManagedEnvironment();
    if (managedEnvironment === null) return false;

    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    const state = yield* DesktopState.DesktopState;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const renderer = resolveBkClientRendererSource({
      managedHttpBaseUrl: managedEnvironment.httpBaseUrl,
      isDevelopment: environment.isDevelopment,
      devServerUrl: Option.getOrNull(environment.devServerUrl),
      clientAssetsDirectory: environment.clientAssetsDirectory,
    });

    // Upstream's protocol either serves the packaged client from disk or proxies a
    // dev server; the managed build picks the same way. The backend origin is not
    // the protocol's concern — handleBackendReady below receives it.
    const protocolScheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
    yield* electronProtocol.registerDesktopProtocol(
      renderer.clientAssetsDirectory
        ? {
            scheme: protocolScheme,
            clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
            assetDirectory: renderer.clientAssetsDirectory,
          }
        : {
            scheme: protocolScheme,
            clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
            targetOrigin: renderer.targetOrigin,
          },
    );
    yield* installDesktopIpcHandlers();
    yield* logInfo("managed desktop ready", {
      channel: managedEnvironment.channel,
      primaryEnvironment: managedEnvironment.httpBaseUrl,
      renderer: renderer.clientAssetsDirectory ? "packaged-client" : "development-server",
    });

    if (!(yield* Ref.get(state.quitting))) {
      yield* desktopWindow.handleBackendReady(renderer.backendOrigin);
      // T3-CUSTOM(expbkt3): upstream starts activation in its bootstrap, which this
      // managed path replaces. Its socket belongs to the app, not a backend.
      const appActivation = yield* DesktopAppActivation.DesktopAppActivation;
      yield* appActivation.start.pipe(
        Effect.tap(() => logInfo("desktop app control socket ready")),
        Effect.catch((error) => logWarning("desktop app control socket unavailable", { error })),
      );
    }

    // After the window: a slow or failed local backend must never delay or
    // block the managed client, so it comes up on a forked fiber.
    yield* Effect.forkScoped(startBkBundledBackend(managedEnvironment.channel));
    return true;
  }).pipe(Effect.withSpan("desktop.bootstrap.bkManaged"));
