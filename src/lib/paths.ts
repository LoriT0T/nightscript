/**
 * A GitHub project page is served from a subdirectory, so every hand-built asset URL needs
 * the base path in front of it. `next/link` and the bundler handle their own URLs; anything
 * passed to `fetch` or `new Audio()` does not, and silently 404s without this.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function asset(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${clean}`;
}
