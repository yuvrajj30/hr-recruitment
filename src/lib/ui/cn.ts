// Joins class names, skipping empty ones: cn("a", cond && "b") -> "a b" or "a".
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
