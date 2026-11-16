/**
 * Concurrency primitives that replace the Python threading ones: a cancel flag, cancellable sleeps,
 * a worker pool with as-completed iteration, and the shared RateGate.
 */
import { Cancelled } from "./errors.js";

/** Cancel that is set either by the caller's AbortSignal or by this run (abort). Waits wake on both. */
export class CancelFlag {
  private readonly own = new AbortController();
  private readonly external: AbortSignal[];

  constructor(...external: Array<AbortSignal | undefined | null>) {
    this.external = external.filter((s): s is AbortSignal => !!s);
  }

  set(): void {
    this.own.abort();
  }

  /** Aborts when the flag is set, so an in-flight request can be cut short instead of waiting for its timeout. */
  get signal(): AbortSignal {
    return AbortSignal.any([this.own.signal, ...this.external]);
  }

  isSet(): boolean {
    return this.own.signal.aborted || this.external.some((s) => s.aborted);
  }

  throwIfSet(): void {
    if (this.isSet()) throw new Cancelled();
  }

  /** Sleep up to `ms`; resolves true as soon as the flag is set, false when the time ran out. */
  wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.isSet()) return resolve(true);
      const signals = [this.own.signal, ...this.external];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(true);
      };
      const cleanup = (): void => {
        for (const s of signals) s.removeEventListener("abort", onAbort);
      };
      timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, Math.max(0, ms));
      for (const s of signals) s.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Cancellation-aware sleep: throws Cancelled when the flag is set before the time is up. */
  async sleep(seconds: number): Promise<void> {
    if (seconds > 0 && (await this.wait(seconds * 1000))) throw new Cancelled();
  }
}

export type Settled<T> = { cancelled: true } | { cancelled: false; ok: true; value: T } | { cancelled: false; ok: false; error: unknown };

export interface TaskHandle<T> {
  /** resolves (never rejects) once the task finished, failed, or was cancelled before starting */
  done: Promise<Settled<T>>;
  /** cancel a task that has not started; returns false when it already runs or finished */
  cancel(): boolean;
  /** the settled outcome once `done` resolved */
  result: Settled<T> | undefined;
}

/** Fixed-size worker pool. Tasks start in submission order; running tasks cannot be interrupted. */
export class TaskPool {
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly maxWorkers: number) {
    this.maxWorkers = Math.max(1, maxWorkers);
  }

  submit<T>(fn: () => Promise<T>): TaskHandle<T> {
    let resolveDone!: (value: Settled<T>) => void;
    const handle: TaskHandle<T> = {
      done: new Promise<Settled<T>>((r) => (resolveDone = r)),
      result: undefined,
      cancel: () => {
        const index = this.queue.indexOf(start);
        if (index === -1) return false;
        this.queue.splice(index, 1);
        handle.result = { cancelled: true };
        resolveDone(handle.result);
        return true;
      },
    };
    const finish = (value: Settled<T>): void => {
      handle.result = value;
      resolveDone(value);
      this.running--;
      this.pump();
    };
    const start = (): void => {
      this.running++;
      let promise: Promise<T>;
      try {
        promise = fn();
      } catch (error) {
        return finish({ cancelled: false, ok: false, error });
      }
      promise.then(
        (value) => finish({ cancelled: false, ok: true, value }),
        (error) => finish({ cancelled: false, ok: false, error }),
      );
    };
    this.queue.push(start);
    this.pump();
    return handle;
  }

  private pump(): void {
    while (this.running < this.maxWorkers && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
    if (this.running === 0 && this.queue.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Resolves when no task is running or queued (Python `shutdown(wait=True)`). */
  shutdown(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

/** Yield handles in the order their tasks settle (Python `as_completed`). */
export async function* asCompleted<T>(handles: Array<TaskHandle<T>>): AsyncGenerator<TaskHandle<T>> {
  const ready: Array<TaskHandle<T>> = [];
  let wake: (() => void) | null = null;
  let remaining = handles.length;
  for (const handle of handles) {
    void handle.done.then(() => {
      ready.push(handle);
      remaining--;
      wake?.();
    });
  }
  while (remaining > 0 || ready.length > 0) {
    if (ready.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    while (ready.length > 0) yield ready.shift()!;
  }
}

/**
 * One gate per run, shared by every worker. A 429 pauses all workers for the Retry-After period
 * (+/-20% jitter, so they do not wake together) and, for `cooldownSeconds`, halves the number of
 * requests allowed in flight. Times are seconds on a monotonic clock.
 */
export class RateGate {
  readonly base: number;
  readonly cooldownSeconds: number;
  trips = 0;
  private inflight = 0;
  private _pauseUntil = 0;
  private degradedUntil = 0;
  private waiters: Array<() => void> = [];

  constructor(
    base: number,
    cooldownSeconds = 60,
    private readonly clock: () => number = () => performance.now() / 1000,
    private readonly rng: () => number = Math.random,
  ) {
    this.base = Math.max(1, Math.trunc(base));
    this.cooldownSeconds = Number(cooldownSeconds);
  }

  get pauseUntil(): number {
    return this._pauseUntil;
  }

  capacity(): number {
    if (this.clock() < this.degradedUntil) return Math.max(1, Math.floor(this.base / 2));
    return this.base;
  }

  async acquire(cancel?: CancelFlag): Promise<void> {
    for (;;) {
      if (cancel?.isSet()) throw new Cancelled();
      const now = this.clock();
      if (now >= this._pauseUntil && this.inflight < this.capacity()) {
        this.inflight++;
        return;
      }
      const remaining = now < this._pauseUntil ? this._pauseUntil - now : 0.5;
      const ms = Math.min(0.5, Math.max(0.05, remaining)) * 1000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        const waiters = this.waiters;
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        waiters.push(done);
      });
    }
  }

  release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.notifyAll();
  }

  onRateLimited(waitSeconds: number): void {
    const now = this.clock();
    const pause = Math.max(0, Number(waitSeconds)) * (0.8 + 0.4 * this.rng());
    this._pauseUntil = Math.max(this._pauseUntil, now + pause);
    this.degradedUntil = Math.max(this.degradedUntil, now + this.cooldownSeconds);
    this.trips++;
    this.notifyAll();
  }

  private notifyAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
