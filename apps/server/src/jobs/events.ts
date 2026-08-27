import type {StepState} from "@travel-movie/schema";

export interface JobProgressEvent {
  readonly etaSec: number | null;
  readonly message: string | null;
  readonly progress: number;
  readonly state: StepState;
  readonly step: string;
}

type EventListener = (event: JobProgressEvent) => void;

export class JobEventBroker {
  readonly #listeners = new Map<string, Set<EventListener>>();
  readonly #snapshots = new Map<string, Map<string, JobProgressEvent>>();
  readonly #lastUpdated = new Map<string, number>();
  readonly #maxProjects = 500;
  readonly #ttlMs = 24 * 60 * 60 * 1000;

  publish(projectId: string, event: JobProgressEvent): void {
    const projectSnapshot = this.#snapshots.get(projectId) ?? new Map<string, JobProgressEvent>();
    projectSnapshot.set(event.step, event);
    this.#snapshots.set(projectId, projectSnapshot);
    this.#lastUpdated.set(projectId, Date.now());
    // LRU eviction if too many projects
    if (this.#snapshots.size > this.#maxProjects) {
      this.#pruneOldest();
    }
    for (const listener of this.#listeners.get(projectId) ?? []) {
      listener(event);
    }
  }

  snapshot(projectId: string): JobProgressEvent[] {
    this.#pruneStale();
    return [...(this.#snapshots.get(projectId)?.values() ?? [])].sort((left, right) =>
      left.step.localeCompare(right.step),
    );
  }

  subscribe(projectId: string, listener: EventListener): () => void {
    const listeners = this.#listeners.get(projectId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(projectId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(projectId);
        // Keep snapshot for TTL period for late SSE reconnects; will be pruned by #pruneStale
      }
    };
  }

  clear(projectId: string): void {
    this.#snapshots.delete(projectId);
    this.#lastUpdated.delete(projectId);
    this.#listeners.delete(projectId);
  }

  #pruneStale(): void {
    const now = Date.now();
    for (const [projectId, updatedAt] of this.#lastUpdated) {
      if (now - updatedAt > this.#ttlMs && !this.#listeners.has(projectId)) {
        this.#snapshots.delete(projectId);
        this.#lastUpdated.delete(projectId);
      }
    }
  }

  #pruneOldest(): void {
    let oldestProject: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [projectId, updatedAt] of this.#lastUpdated) {
      if (this.#listeners.has(projectId)) {
        continue;
      }
      if (updatedAt < oldestTime) {
        oldestTime = updatedAt;
        oldestProject = projectId;
      }
    }
    if (oldestProject !== null) {
      this.#snapshots.delete(oldestProject);
      this.#lastUpdated.delete(oldestProject);
    }
  }
}
