import { cn } from "@/lib/ui/cn";

// "Yuvraj Singh Solanki" -> "YS"; "The Trust Coffee" -> "TT"; "" -> "?"
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!.charAt(0);
  const second = words.length > 1 ? words[1]!.charAt(0) : (words[0]!.charAt(1) ?? "");
  return (first + second).toUpperCase();
}

// Initials in a circle (people) or a rounded square (organisations). Decorative: the name is always
// written next to it, so screen readers skip it.
export function Avatar({ name, shape = "circle", size = "md", className }: {
  name: string;
  shape?: "circle" | "square";
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-accent-soft font-semibold text-accent-fg select-none",
        shape === "circle" ? "rounded-full" : "rounded-md",
        size === "sm" ? "size-7 text-[11px]" : "size-8 text-xs",
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
