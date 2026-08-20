export function slugify(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "")
    .replace(/^./, (c) => c.toUpperCase()) || "Character";
}
