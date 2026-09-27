/**
 * T3-CUSTOM(expbkt3): the handoff digest renderer.
 *
 * The implementation moved to `@t3tools/shared/sessionDigest` so a client can
 * render the same digest from its local cache when the host that owns the
 * thread is unreachable. This module stays as the server's import site.
 */
export {
  renderThreadContextDigest,
  selectTranscriptMessages,
  type ContextTranscriptMessage,
  type ThreadContextDigest,
  type ThreadContextDigestInput,
} from "@t3tools/shared/sessionDigest";
