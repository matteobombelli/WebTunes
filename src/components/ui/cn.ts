/** Tiny className joiner — drops falsy values, joins with spaces. */
export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}
