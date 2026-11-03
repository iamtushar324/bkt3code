// T3-CUSTOM(expbkt3): IPC messages between the server and its process host (process-host.expbkt3.ts).
// Both sides import these as types only, so the host stays a plain Node script.

/** 1 is stdout, 2 is stderr. */
export type HostStreamId = 1 | 2;

/** The parts of a Node errno exception that callers inspect, sent instead of the Error object. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
  readonly spawnargs?: ReadonlyArray<string> | undefined;
}

export interface HostSpawnRequest {
  readonly t: "spawn";
  readonly id: number;
  /** Wall-clock deadline: a host that reads the request later answers "declined" and spawns nothing. */
  readonly notAfter: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  /** The complete child environment, already merged the way Node's spawner merges it. */
  readonly env: Record<string, string>;
  readonly shell: boolean | string | undefined;
  readonly detached: boolean;
  readonly killSignal: string;
}

export type HostRequest =
  | HostSpawnRequest
  | {
      readonly t: "stdin";
      readonly id: number;
      readonly seq: number;
      readonly data: Uint8Array;
    }
  | { readonly t: "stdinEnd"; readonly id: number; readonly destroy: boolean }
  | {
      readonly t: "ack";
      readonly id: number;
      readonly stream: HostStreamId;
      readonly bytes: number;
    }
  | {
      readonly t: "kill";
      readonly id: number;
      readonly seq: number;
      readonly signal: string;
      readonly forceKillAfterMs: number | undefined;
    }
  | {
      readonly t: "release";
      readonly id: number;
      readonly seq: number;
      readonly referenced: boolean;
      readonly signal: string;
      readonly forceKillAfterMs: number | undefined;
    };

export type HostEvent =
  | { readonly t: "ready"; readonly pid: number }
  | { readonly t: "spawned"; readonly id: number; readonly pid: number }
  | { readonly t: "spawnError"; readonly id: number; readonly error: SerializedError }
  /** The host started nothing: the request expired, or Node threw before starting the child. */
  | { readonly t: "declined"; readonly id: number }
  | {
      readonly t: "out";
      readonly id: number;
      readonly stream: HostStreamId;
      readonly data: Uint8Array;
    }
  | { readonly t: "end"; readonly id: number; readonly stream: HostStreamId }
  | {
      readonly t: "streamError";
      readonly id: number;
      readonly stream: HostStreamId;
      readonly error: SerializedError;
    }
  | {
      readonly t: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: string | null;
    }
  /** Answers a stdin write, kill or release request with the same seq. */
  | {
      readonly t: "reply";
      readonly id: number;
      readonly seq: number;
      readonly error?: SerializedError | undefined;
    };
