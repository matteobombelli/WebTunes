import { cn } from "./cn";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Red hover for remove/delete affordances. */
  danger?: boolean;
};

/** Small square icon-only button used in rows, menus, and toolbars. */
export function IconButton({ danger = false, className, ...props }: Props) {
  return (
    <button
      className={cn(
        "rounded p-1 hover:bg-surface-3 focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent",
        danger ? "hover:text-red-400" : "hover:text-fg",
        className,
      )}
      {...props}
    />
  );
}
