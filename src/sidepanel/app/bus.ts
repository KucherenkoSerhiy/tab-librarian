type Handler = () => Promise<void> | void;
const handlers: Record<string, Handler[]> = {};

export type BusEvent = "refresh" | "proposal";

export function on(event: BusEvent, fn: Handler): void {
  (handlers[event] ??= []).push(fn);
}

export async function emit(event: BusEvent): Promise<void> {
  for (const fn of handlers[event] ?? []) await fn();
}

/** Re-render everything on the home view (implemented in refresh.ts). */
export const requestRefresh = (): Promise<void> => emit("refresh");
