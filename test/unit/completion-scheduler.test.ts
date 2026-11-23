import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionOutcome } from '../../src/application/services/complete-extraction.js';
import { InProcessCompletionScheduler } from '../../src/infrastructure/in-process-completion-scheduler.js';
import { silentLogger } from '../support/services.js';

function create(maxTrackedJobs = 10, shutdownTimeoutMs = 1_000) {
  const logError = vi.fn();
  const logWarn = vi.fn();
  const scheduler = new InProcessCompletionScheduler({
    maxTrackedJobs,
    shutdownTimeoutMs,
    logger: { ...silentLogger(), error: logError, warn: logWarn },
  });
  const handler = vi.fn<(id: string) => Promise<CompletionOutcome>>();
  scheduler.setHandler(handler);
  return { scheduler, handler, logError, logWarn };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('InProcessCompletionScheduler — checks', () => {
  it('runs the handler after the delay and reschedules while pending', async () => {
    const { scheduler, handler } = create();
    handler
      .mockResolvedValueOnce({ state: 'PENDING', nextCheckInMs: 200 })
      .mockResolvedValueOnce({ state: 'COMPLETED' });
    scheduler.schedule('doc-1', 100);

    await vi.advanceTimersByTimeAsync(99);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(handler).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenCalledTimes(2); // stops once no longer pending
    expect(scheduler.trackedCount).toBe(0);
  });

  it('keeps at most one timer per document', async () => {
    const { scheduler, handler } = create();
    handler.mockResolvedValue({ state: 'COMPLETED' });
    scheduler.schedule('doc-1', 100);
    scheduler.schedule('doc-1', 100);
    expect(scheduler.trackedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('survives a crashing handler and stops tracking the document', async () => {
    const { scheduler, handler, logError } = create();
    handler.mockRejectedValueOnce(new Error('boom'));
    scheduler.schedule('doc-1', 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(scheduler.trackedCount).toBe(0);
  });
});

describe('InProcessCompletionScheduler — capacity reservations', () => {
  it('reserves synchronously up to the limit, counting tracked jobs', () => {
    const { scheduler } = create(2);
    const first = scheduler.reserve();
    const second = scheduler.reserve();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(scheduler.reserve()).toBeUndefined();

    second?.release();
    expect(scheduler.usedCapacity).toBe(1);
    scheduler.schedule('doc-1', 100, first); // consumes the reservation
    expect(scheduler.usedCapacity).toBe(1);
    expect(scheduler.reserve()).toBeDefined();
    expect(scheduler.reserve()).toBeUndefined();
  });

  it('treats release as idempotent and as a no-op after the slot was consumed', () => {
    const { scheduler } = create(1);
    const reservation = scheduler.reserve();
    scheduler.schedule('doc-1', 100, reservation);
    reservation?.release();
    reservation?.release();
    expect(scheduler.usedCapacity).toBe(1); // still tracking doc-1
  });

  it('frees the slot when the tracked job finishes', async () => {
    const { scheduler, handler } = create(1);
    handler.mockResolvedValueOnce({ state: 'FAILED' });
    scheduler.schedule('doc-1', 10, scheduler.reserve());
    expect(scheduler.reserve()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(scheduler.usedCapacity).toBe(0);
    expect(scheduler.reserve()).toBeDefined();
  });

  it('refuses reservations after close', async () => {
    const { scheduler } = create();
    await scheduler.close();
    expect(scheduler.reserve()).toBeUndefined();
  });
});

describe('InProcessCompletionScheduler — shutdown', () => {
  it('cancels pending timers and ignores later schedules', async () => {
    const { scheduler, handler } = create();
    scheduler.schedule('doc-1', 100);
    await scheduler.close();
    scheduler.schedule('doc-2', 100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('waits for an in-flight check before resolving', async () => {
    const { scheduler, handler } = create(10, 5_000);
    let finish: (outcome: CompletionOutcome) => void = () => undefined;
    handler.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    scheduler.schedule('doc-1', 10);
    await vi.advanceTimersByTimeAsync(10); // check now in flight

    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toBe(false);

    finish({ state: 'COMPLETED' });
    await closing;
    expect(closed).toBe(true);
  });

  it('gives up after the shutdown deadline and logs it', async () => {
    const { scheduler, handler, logWarn } = create(10, 500);
    handler.mockReturnValueOnce(new Promise(() => undefined)); // never settles
    scheduler.schedule('doc-1', 10);
    await vi.advanceTimersByTimeAsync(10);

    const closing = scheduler.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ inFlight: 1, timeoutMs: 500 }),
      expect.stringContaining('Shutdown deadline'),
    );
  });

  it('does not reschedule a check that reports PENDING after close', async () => {
    const { scheduler, handler, logWarn } = create();
    let finish: (outcome: CompletionOutcome) => void = () => undefined;
    handler.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    scheduler.schedule('doc-1', 10);
    await vi.advanceTimersByTimeAsync(10);
    const closing = scheduler.close();
    finish({ state: 'PENDING', nextCheckInMs: 10 });
    await closing;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      { abandonedJobs: 1 },
      expect.stringContaining('abandoned'),
    );
  });
});
