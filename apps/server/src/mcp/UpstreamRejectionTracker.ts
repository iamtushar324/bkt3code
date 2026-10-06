// @effect-diagnostics nodeBuiltinImport:off - fork code still hashes with node:crypto; moving it to Effect Crypto (#16377) is a follow-up.
/**
 * T3-CUSTOM(expbkt3): Counts consecutive upstream 401s per stored credential.
 *
 * One 401 from toolyard is not proof the stored token is dead: its `/mcp`
 * guard can answer 401 on a transient verification error. So the proxy retires
 * a token only after two consecutive rejections of the same credential within
 * a short window. A credential is identified by a hash, never kept in clear;
 * the strikes forget on the first accepted call, when the threshold trips,
 * or once the window has passed. Pure and clock-free so it can be tested
 * without a runtime; the caller supplies the time.
 */
import * as NodeCrypto from "node:crypto";

export interface UpstreamRejectionTracker {
  /**
   * Records one rejection. `true` exactly when this one crosses the threshold;
   * the count then restarts, so the next rejection is a first strike again.
   */
  readonly recordRejection: (key: string, nowMillis: number) => boolean;
  /** An accepted call for this credential clears its strikes. */
  readonly recordAcceptance: (key: string) => void;
  /** Credentials with an open strike. Exposed for tests. */
  readonly size: () => number;
}

/** One user's one credential, without the credential itself. */
export const rejectionKey = (userId: string, credential: string): string =>
  `${userId}:${NodeCrypto.createHash("sha256").update(credential, "utf8").digest("hex")}`;

export const makeUpstreamRejectionTracker = (options: {
  /** Rejections in a row that retire the credential. */
  readonly threshold: number;
  /** A strike older than this no longer counts. */
  readonly windowMs: number;
}): UpstreamRejectionTracker => {
  const strikes = new Map<string, { readonly count: number; readonly lastAt: number }>();
  const forgetExpired = (nowMillis: number) => {
    for (const [key, entry] of strikes) {
      if (nowMillis - entry.lastAt > options.windowMs) strikes.delete(key);
    }
  };
  return {
    recordRejection: (key, nowMillis) => {
      forgetExpired(nowMillis);
      const count = (strikes.get(key)?.count ?? 0) + 1;
      if (count >= options.threshold) {
        strikes.delete(key);
        return true;
      }
      strikes.set(key, { count, lastAt: nowMillis });
      return false;
    },
    recordAcceptance: (key) => {
      strikes.delete(key);
    },
    size: () => strikes.size,
  };
};
