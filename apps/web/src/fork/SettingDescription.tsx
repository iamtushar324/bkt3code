/** T3-CUSTOM(expbkt3): a settings row description that keeps its long explanation behind "More". */
import { useState } from "react";

/** One visible sentence, with the long explanation toggled inline (the row's `<p>` allows only phrasing content). */
export function SettingDescription({
  summary,
  details,
}: {
  readonly summary: string;
  readonly details: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {summary}
      {open ? ` ${details}` : null}{" "}
      <button
        type="button"
        aria-expanded={open}
        className="cursor-pointer rounded-sm font-medium text-foreground/70 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Less" : "More"}
      </button>
    </>
  );
}
