import { cn } from "./cn";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-1.5 font-semibold whitespace-nowrap " +
  "disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-surface-0";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-surface-3 text-fg hover:bg-border",
  outline: "border border-border text-fg hover:border-fg-muted hover:bg-surface-2/50",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  destructive: "text-red-400 hover:bg-red-500/10",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  pill?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  pill = false,
  className,
  ...props
}: Props) {
  return (
    <button
      className={cn(
        base,
        variants[variant],
        sizes[size],
        pill ? "rounded-full" : "rounded-md",
        className,
      )}
      {...props}
    />
  );
}
