/**
 * T3-CUSTOM(expbkt3): rendered node components for the plan review editor.
 *
 * Plate registers node *types*; without a component per type every block falls
 * back to an unstyled div, which is why the first cut rendered headings at body
 * size. These are adapted from Plate's MIT registry components, restyled onto
 * this app's design tokens rather than the registry's own theme — we have no
 * `@tailwindcss/typography`, so the hierarchy is spelled out here.
 */
import { useTodoListElement, useTodoListElementState } from "@platejs/list-classic/react";
import { type VariantProps, cva } from "class-variance-authority";
import {
  PlateElement,
  PlateLeaf,
  type PlateElementProps,
  type PlateLeafProps,
} from "platejs/react";
import { Children } from "react";

import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../../lib/utils";
import { useTheme } from "../../../hooks/useTheme";
import { PlanReviewMermaid } from "./PlanReviewMermaid";

/** Plate keeps a code block's fence language on the element as `lang`. */
function codeBlockLanguage(element: unknown): string {
  const lang = (element as { lang?: unknown }).lang;
  return typeof lang === "string" ? lang.trim().toLowerCase() : "";
}

/** Slate stores text in leaves; a code block's source is its descendant text. */
function codeBlockText(element: unknown): string {
  const collect = (node: unknown): string => {
    if (typeof (node as { text?: unknown }).text === "string") {
      return (node as { text: string }).text;
    }
    const children = (node as { children?: unknown }).children;
    return Array.isArray(children) ? children.map(collect).join("\n") : "";
  };
  const children = (element as { children?: unknown }).children;
  return Array.isArray(children) ? children.map(collect).join("\n") : "";
}

const headingVariants = cva("relative font-semibold text-foreground", {
  variants: {
    variant: {
      h1: "mt-6 mb-2 text-2xl leading-tight first:mt-0",
      h2: "mt-6 mb-2 text-xl leading-tight first:mt-0",
      h3: "mt-5 mb-1.5 text-lg leading-snug first:mt-0",
      h4: "mt-4 mb-1 text-base first:mt-0",
      h5: "mt-4 mb-1 text-sm first:mt-0",
      h6: "mt-4 mb-1 text-muted-foreground text-sm uppercase tracking-wide first:mt-0",
    },
  },
});

function HeadingElement({
  variant = "h1",
  ...props
}: PlateElementProps & VariantProps<typeof headingVariants>) {
  return (
    <PlateElement as={variant ?? "h1"} className={headingVariants({ variant })} {...props}>
      {props.children}
    </PlateElement>
  );
}

export const H1Element = (props: PlateElementProps) => <HeadingElement variant="h1" {...props} />;
export const H2Element = (props: PlateElementProps) => <HeadingElement variant="h2" {...props} />;
export const H3Element = (props: PlateElementProps) => <HeadingElement variant="h3" {...props} />;
export const H4Element = (props: PlateElementProps) => <HeadingElement variant="h4" {...props} />;
export const H5Element = (props: PlateElementProps) => <HeadingElement variant="h5" {...props} />;
export const H6Element = (props: PlateElementProps) => <HeadingElement variant="h6" {...props} />;

export function ParagraphElement(props: PlateElementProps) {
  return (
    <PlateElement className="my-1.5 text-[15px] leading-relaxed" {...props}>
      {props.children}
    </PlateElement>
  );
}

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="blockquote"
      className="my-3 border-primary/40 border-l-2 py-0.5 pl-4 text-muted-foreground italic"
      {...props}
    >
      {props.children}
    </PlateElement>
  );
}

export function HorizontalRuleElement(props: PlateElementProps) {
  return (
    <PlateElement className="my-5" {...props}>
      <div contentEditable={false}>
        <hr className="border-border border-t" />
      </div>
      {props.children}
    </PlateElement>
  );
}

export function CodeBlockElement(props: PlateElementProps) {
  const { resolvedTheme } = useTheme();
  const isMermaid = codeBlockLanguage(props.element) === "mermaid";

  if (isMermaid) {
    return (
      <PlateElement {...props}>
        {/* The rendered diagram is decoration; the code lines stay in the
            document so the text remains selectable, editable and serializable. */}
        <div contentEditable={false} className="select-none">
          <PlanReviewMermaid
            code={codeBlockText(props.element)}
            isDark={resolvedTheme === "dark"}
          />
        </div>
        <div className="sr-only">{props.children}</div>
      </PlateElement>
    );
  }

  return (
    <PlateElement
      className="my-3 overflow-x-auto rounded-md border bg-muted/50 py-2.5 font-mono text-[13px] leading-relaxed"
      {...props}
    >
      <code>{props.children}</code>
    </PlateElement>
  );
}

export function CodeLineElement(props: PlateElementProps) {
  return (
    <PlateElement as="div" className="px-3" {...props}>
      {props.children}
    </PlateElement>
  );
}

export function LinkElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="a"
      className="cursor-pointer font-medium text-primary underline decoration-primary/40 underline-offset-2"
      {...props}
      attributes={{
        ...props.attributes,
        // Plans reference issues and docs; a review should be able to follow them.
        target: "_blank",
        rel: "noreferrer noopener",
      }}
    >
      {props.children}
    </PlateElement>
  );
}

const listVariants = cva("my-1.5 ps-6", {
  variants: {
    variant: {
      ol: "list-decimal marker:text-muted-foreground",
      ul: "list-disc marker:text-muted-foreground [&_ul]:list-[circle] [&_ul_ul]:list-[square]",
    },
  },
});

function ListElement({ variant, ...props }: PlateElementProps & VariantProps<typeof listVariants>) {
  return (
    <PlateElement as={variant ?? "ul"} className={listVariants({ variant })} {...props}>
      {props.children}
    </PlateElement>
  );
}

export const BulletedListElement = (props: PlateElementProps) => (
  <ListElement variant="ul" {...props} />
);
export const NumberedListElement = (props: PlateElementProps) => (
  <ListElement variant="ol" {...props} />
);

export function TaskListElement(props: PlateElementProps) {
  return (
    <PlateElement as="ul" className="my-1.5 list-none ps-1" {...props}>
      {props.children}
    </PlateElement>
  );
}

function BaseListItemElement(props: PlateElementProps) {
  return (
    <PlateElement as="li" className="text-[15px] leading-relaxed" {...props}>
      {props.children}
    </PlateElement>
  );
}

function TaskListItemElement(props: PlateElementProps) {
  const state = useTodoListElementState({ element: props.element });
  const { checkboxProps } = useTodoListElement(state);
  const [firstChild, ...otherChildren] = Children.toArray(props.children);

  return (
    <BaseListItemElement {...props}>
      <div className="flex items-start gap-2">
        <div contentEditable={false} className="mt-1 select-none">
          <Checkbox {...checkboxProps} />
        </div>
        <span className={cn("flex-1", state.checked && "text-muted-foreground line-through")}>
          {firstChild}
        </span>
      </div>
      {otherChildren}
    </BaseListItemElement>
  );
}

export function ListItemElement(props: PlateElementProps) {
  // The classic list model puts `checked` on the item itself for task lists.
  return "checked" in props.element ? (
    <TaskListItemElement {...props} />
  ) : (
    <BaseListItemElement {...props} />
  );
}

export function TableElement(props: PlateElementProps) {
  return (
    <PlateElement className="my-3 overflow-x-auto" {...props}>
      <table className="w-full border-collapse text-sm">
        <tbody>{props.children}</tbody>
      </table>
    </PlateElement>
  );
}

export function TableRowElement(props: PlateElementProps) {
  return (
    <PlateElement as="tr" className="border-border border-b" {...props}>
      {props.children}
    </PlateElement>
  );
}

export function TableCellElement(props: PlateElementProps) {
  return (
    <PlateElement as="td" className="border border-border px-2.5 py-1.5 align-top" {...props}>
      {props.children}
    </PlateElement>
  );
}

export function TableCellHeaderElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="th"
      className="border border-border bg-muted/50 px-2.5 py-1.5 text-left font-semibold"
      {...props}
    >
      {props.children}
    </PlateElement>
  );
}

export function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      as="code"
      className="rounded border bg-muted px-1 py-0.5 font-mono text-[0.9em]"
      {...props}
    >
      {props.children}
    </PlateLeaf>
  );
}

export function HighlightLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      as="mark"
      className="rounded-sm bg-amber-200/70 text-inherit dark:bg-amber-400/30"
      {...props}
    >
      {props.children}
    </PlateLeaf>
  );
}

export function KbdLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      as="kbd"
      className="rounded border border-border border-b-2 bg-muted px-1.5 py-0.5 font-mono text-[0.8em]"
      {...props}
    >
      {props.children}
    </PlateLeaf>
  );
}
