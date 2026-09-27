import "./RunningSessionGlint.css";

/** A duty-cycled compositor-only sweep for rows with live agent work. */
export function RunningSessionGlint() {
  return <span aria-hidden className="phase-running-session-glint" />;
}
