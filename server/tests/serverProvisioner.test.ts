import { describe, expect, test } from "bun:test";
import { HttpError } from "../utils/http.ts";
import { ServerProvisioner } from "../utils/serverProvisioner.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("ServerProvisioner", () => {
  test("propagates request cancellation through its owned signal", async () => {
    const provisioner = new ServerProvisioner();
    const request = new AbortController();
    const entered = deferred<void>();
    const reason = new Error("request disconnected");
    let operationSignal: AbortSignal | undefined;

    const result = provisioner.run(request.signal, async (signal) => {
      operationSignal = signal;
      entered.resolve(undefined);
      await waitForAbort(signal);
      signal.throwIfAborted();
      return "unreachable";
    });
    const observedResult = result.catch((error) => error as unknown);

    await entered.promise;
    request.abort(reason);

    expect(await observedResult).toBe(reason);
    expect(operationSignal).toBeDefined();
    expect(operationSignal!.aborted).toBe(true);
    expect(operationSignal!.reason).toBe(reason);
    await provisioner.shutdown();
  });

  test("does not invoke an operation for an already-aborted request", async () => {
    const provisioner = new ServerProvisioner();
    const request = new AbortController();
    const reason = new Error("request was already closed");
    let invoked = false;
    request.abort(reason);

    const result = provisioner.run(request.signal, async () => {
      invoked = true;
      return "unreachable";
    });

    expect(await result.catch((error) => error as unknown)).toBe(reason);
    expect(invoked).toBe(false);
    await provisioner.shutdown();
  });

  test("shutdown aborts active work and waits for its finally cleanup", async () => {
    const provisioner = new ServerProvisioner();
    const request = new AbortController();
    const entered = deferred<void>();
    const releaseCleanup = deferred<void>();
    let cleanupStarted = false;
    let cleanupFinished = false;

    const operation = provisioner.run(request.signal, async (signal) => {
      entered.resolve(undefined);
      try {
        await waitForAbort(signal);
        signal.throwIfAborted();
      } finally {
        cleanupStarted = true;
        await releaseCleanup.promise;
        cleanupFinished = true;
      }
    });
    const observedOperation = operation.catch((error) => error as unknown);
    await entered.promise;

    const firstShutdown = provisioner.shutdown();
    const secondShutdown = provisioner.shutdown();
    expect(secondShutdown).toBe(firstShutdown);

    let shutdownFinished = false;
    void firstShutdown.then(() => {
      shutdownFinished = true;
    });
    await Bun.sleep(10);
    expect(cleanupStarted).toBe(true);
    expect(cleanupFinished).toBe(false);
    expect(shutdownFinished).toBe(false);

    releaseCleanup.resolve(undefined);
    await firstShutdown;
    expect(cleanupFinished).toBe(true);
    expect(shutdownFinished).toBe(true);

    const operationError = await observedOperation;
    expect(operationError).toBeInstanceOf(HttpError);
    expect((operationError as HttpError).status).toBe(503);
    expect((operationError as Error).message).toBe("The panel is shutting down");

    const rejectedAdmission = provisioner.run(new AbortController().signal, async () => "late");
    const admissionError = await rejectedAdmission.catch((error) => error as unknown);
    expect(admissionError).toBeInstanceOf(HttpError);
    expect((admissionError as HttpError).status).toBe(503);
  });

  test("detaches the request listener after successful completion", async () => {
    const provisioner = new ServerProvisioner();
    const request = new AbortController();
    let operationSignal: AbortSignal | undefined;

    expect(
      await provisioner.run(request.signal, async (signal) => {
        operationSignal = signal;
        return "complete";
      }),
    ).toBe("complete");

    request.abort(new Error("late cancellation"));
    expect(operationSignal).toBeDefined();
    expect(operationSignal!.aborted).toBe(false);
    await provisioner.shutdown();
  });

  test("reports cleanup failures instead of hiding them during shutdown", async () => {
    const provisioner = new ServerProvisioner();
    const entered = deferred<void>();
    const cleanupError = new Error("process group cleanup failed");
    const operation = provisioner.run(new AbortController().signal, async (signal) => {
      entered.resolve(undefined);
      await waitForAbort(signal);
      throw cleanupError;
    });
    const observedOperation = operation.catch((error) => error as unknown);
    await entered.promise;

    const shutdownError = await provisioner.shutdown().catch((error) => error as unknown);
    expect(shutdownError).toBeInstanceOf(AggregateError);
    expect((shutdownError as AggregateError).errors).toEqual([cleanupError]);
    expect(await observedOperation).toBe(cleanupError);
  });
});
