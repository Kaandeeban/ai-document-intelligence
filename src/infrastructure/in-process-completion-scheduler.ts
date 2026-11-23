import type {
  CapacityReservation,
  CompletionScheduler,
  Logger,
} from '../application/ports/index.js';
import type { CompletionOutcome } from '../application/services/complete-extraction.js';

export type CompletionHandler = (documentId: string) => Promise<CompletionOutcome>;

export interface InProcessCompletionSchedulerOptions {
  /** Upper bound on asynchronous jobs at once: reservations + tracked documents. */
  readonly maxTrackedJobs: number;
  readonly logger: Logger;
  /** How long `close()` waits for in-flight checks before giving up. */
  readonly shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Milestone 2 completion trigger: one timer per pending document, never a scan
 * or an unbounded loop. Each run performs a single status check; the handler
 * decides whether, and how soon, to check again (bounded by the job timeout).
 *
 * Capacity: `reserve()` is synchronous, so the check-and-take of a slot cannot
 * interleave with other requests in this process.
 *
 * Limitations: state is per process and lost on restart; not safe for multiple
 * instances. Milestone 4 replaces this with SNS/SQS completion notifications.
 */
export class InProcessCompletionScheduler implements CompletionScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  /** Documents currently tracked (timer pending or check running). */
  private readonly tracked = new Set<string>();
  private readonly reservations = new Set<CapacityReservation>();
  private handler: CompletionHandler | undefined;
  private closed = false;

  constructor(private readonly options: InProcessCompletionSchedulerOptions) {}

  /** Set once in the composition root (breaks the service ↔ scheduler cycle). */
  setHandler(handler: CompletionHandler): void {
    this.handler = handler;
  }

  /** Slots in use: unconsumed reservations plus tracked documents. */
  get usedCapacity(): number {
    return this.reservations.size + this.tracked.size;
  }

  get trackedCount(): number {
    return this.tracked.size;
  }

  reserve(): CapacityReservation | undefined {
    if (this.closed || this.usedCapacity >= this.options.maxTrackedJobs) return undefined;
    const reservation: CapacityReservation = {
      release: () => {
        this.reservations.delete(reservation);
      },
    };
    this.reservations.add(reservation);
    return reservation;
  }

  schedule(documentId: string, delayMs: number, reservation?: CapacityReservation): void {
    if (reservation) this.reservations.delete(reservation);
    if (this.closed) return;
    this.tracked.add(documentId);
    const existing = this.timers.get(documentId);
    if (existing) clearTimeout(existing); // at most one timer per document
    const timer = setTimeout(() => {
      this.timers.delete(documentId);
      if (this.running.has(documentId)) return; // a check is already in flight
      const run = this.run(documentId).finally(() => {
        this.running.delete(documentId);
      });
      this.running.set(documentId, run);
    }, delayMs);
    timer.unref(); // never keeps the process alive
    this.timers.set(documentId, timer);
  }

  /**
   * Stops new work, cancels pending timers and waits (bounded) for in-flight
   * checks so AWS clients are not destroyed underneath them. Checks that still
   * report PENDING after close are not rescheduled; those jobs are abandoned
   * (no durable job tracking until Milestone 4/5).
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.reservations.clear();

    const inFlight = [...this.running.values()];
    if (inFlight.length > 0) {
      const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      let deadline: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        deadline = setTimeout(() => {
          resolve('timeout');
        }, timeoutMs);
        deadline.unref();
      });
      const result = await Promise.race([Promise.allSettled(inFlight), timedOut]);
      clearTimeout(deadline);
      if (result === 'timeout') {
        this.options.logger.warn(
          { inFlight: this.running.size, timeoutMs },
          'Shutdown deadline reached with OCR completion checks still running',
        );
      }
    }
    if (this.tracked.size > 0) {
      this.options.logger.warn(
        { abandonedJobs: this.tracked.size },
        'Asynchronous OCR jobs abandoned at shutdown (no durable job tracking yet)',
      );
    }
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private async run(documentId: string): Promise<void> {
    if (this.closed || !this.handler) return;
    let reschedule: number | undefined;
    try {
      const outcome = await this.handler(documentId);
      if (outcome.state === 'PENDING') reschedule = outcome.nextCheckInMs;
    } catch (error) {
      // The handler records expected failures itself; this is a last-resort guard.
      this.options.logger.error({ documentId, err: error }, 'OCR completion check crashed');
    }
    // Re-read through a method: close() may have run while the handler was awaited.
    if (reschedule !== undefined && !this.isClosed()) {
      this.schedule(documentId, reschedule);
    } else if (reschedule === undefined) {
      this.tracked.delete(documentId); // finished: completed, failed or ignored
    }
  }
}
