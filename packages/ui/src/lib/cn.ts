import { type ClassValue, clsx } from "clsx";

/** Joins class names. Kept tiny on purpose: components avoid conflicting utilities instead of merging them. */
export function cn(...values: ClassValue[]): string {
  return clsx(values);
}
