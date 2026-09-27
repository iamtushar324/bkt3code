/**
 * T3-CUSTOM(expbkt3): MattermostThreadBadge - this session is being watched
 * from a Mattermost conversation.
 *
 * The Linear/Mattermost bridge binds a session to a Mattermost thread so a
 * human can steer it from chat, but until now that binding was invisible
 * inside T3: the sidebar looked identical whether or not replies in chat were
 * landing in the session. This puts the Mattermost mark in the same
 * bottom-right lane as the priority badge, owner avatar and provider icon, so
 * "someone is following this from chat" reads at a glance.
 *
 * Rendered inside the row's <button>, so it is a labelled span rather than an
 * anchor - opening the conversation lives in the row's context menu, because
 * an <a> nested in a <button> is invalid HTML and swallows row selection.
 *
 * @module components/sidebar/MattermostThreadBadge
 */
import type { SVGProps } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Official Mattermost brand mark (docs/site/static/img/brand/icon-denim.svg in
 * mattermost/mattermost), recoloured to currentColor so it inherits the lane's
 * adaptive text colour instead of the brand denim, which vanishes in dark mode.
 */
export function MattermostIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 140 140" fill="currentColor" fillRule="evenodd" aria-hidden {...props}>
      <path d="M111.11,13.36l.74,14.86c12.04,13.3,16.8,32.15,10.81,49.86-8.95,26.44-38.46,40.33-65.92,31.04-27.46-9.29-42.45-38.26-33.5-64.7,6.01-17.77,21.32-29.87,39.05-33.07L71.87.03C41.99-.77,13.8,17.77,3.72,47.55c-12.4,36.6,7.24,76.33,43.85,88.73,36.6,12.4,76.33-7.24,88.73-43.85,10.07-29.74-1-61.55-25.14-79.07h-.03Z" />
      <path d="M93.95,57.21l-.51-20.77-.41-11.95-.28-10.35s.07-4.99-.11-6.16c-.03-.25-.11-.44-.21-.62,0-.03-.02-.05-.03-.07,0-.02-.03-.05-.03-.07-.2-.33-.49-.59-.89-.72s-.8-.1-1.17.05h-.02s-.08.03-.13.07c-.16.08-.34.2-.51.36-.85.82-3.84,4.83-3.84,4.83l-6.5,8.06-7.59,9.25-13.02,16.19s-5.98,7.46-4.65,16.64c1.31,9.18,8.15,13.65,13.43,15.44,5.29,1.79,13.43,2.38,20.05-4.11,6.62-6.49,6.4-16.04,6.4-16.04l.02-.02Z" />
    </svg>
  );
}

/**
 * Presentation only, so it can be asserted without a thread row or the atom
 * runtime. Sized to the 3.5 lane the priority badge and provider icon share.
 */
export function MattermostThreadBadge({
  label,
  threadId,
}: {
  readonly label: string;
  readonly threadId: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="inline-flex size-3.5 shrink-0 items-center justify-center text-[#1e325c] dark:text-[#8fa9e8]"
            data-testid={`phase-thread-mattermost-${threadId}`}
            role="img"
          />
        }
      >
        <MattermostIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
