// @effect-diagnostics nodeBuiltinImport:off - a process-lifetime id must exist before any Effect runs.
import * as NodeCrypto from "node:crypto";

/**
 * Changes on every server start. Clients resume their shell cursor on a new socket only
 * while it is unchanged, so a restart or deploy still forces a full shell snapshot.
 */
export const SERVER_INSTANCE_ID = NodeCrypto.randomUUID();
