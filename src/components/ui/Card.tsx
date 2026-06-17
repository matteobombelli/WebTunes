import { cn } from "./cn";

/** Shared card shell with a subtle hover-lift. Also usable on a <Link> via the
 *  exported class string for cases that need a non-div element. */
export const cardClass =
  "rounded-lg border border-border-subtle bg-surface-1 transition duration-150 " +
  "hover:-translate-y-0.5 hover:border-border hover:bg-surface-2/60 " +
  "hover:shadow-lg hover:shadow-black/30";

type Props = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: Props) {
  return <div className={cn(cardClass, className)} {...props} />;
}
