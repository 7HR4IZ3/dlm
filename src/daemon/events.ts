import type { DaemonEvent } from "../domain/types";
import { createId } from "../lib/ids";
import { nowIso } from "../lib/time";

export class EventHub {
  private readonly listeners = new Set<(event: DaemonEvent) => void>();

  subscribe(listener: (event: DaemonEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  create(type: string, payload: Record<string, unknown>, downloadId: string | null = null): DaemonEvent {
    return {
      id: createId("evt"),
      type,
      downloadId,
      timestamp: nowIso(),
      payload,
    };
  }

  publish(event: DaemonEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

