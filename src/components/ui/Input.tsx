import { cn } from "./cn";

type Props = React.InputHTMLAttributes<HTMLInputElement>;

/** Shared text field: dark raised surface, accent focus ring. */
export function Input({ className, ...props }: Props) {
  return (
    <input
      className={cn(
        "rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg",
        "placeholder:text-fg-subtle outline-none transition",
        "focus:border-accent focus:ring-2 focus:ring-accent/30",
        className,
      )}
      {...props}
    />
  );
}
