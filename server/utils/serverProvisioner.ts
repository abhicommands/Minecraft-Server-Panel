import { HttpError } from "./http.ts";

type TrackedOperation<T> = (signal: AbortSignal) => Promise<T>;

interface OperationRegistration {
  readonly controller: AbortController;
  readonly requestSignal: AbortSignal;
  readonly onRequestAbort: () => void;
  listening: boolean;
}

const SHUTDOWN_MESSAGE = "The panel is shutting down";

export class ServerProvisioner {
  private readonly registrations = new Set<OperationRegistration>();
  private readonly activeOperations = new Map<Promise<unknown>, OperationRegistration>();
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;

  private detachRequestSignal(registration: OperationRegistration): void {
    if (!registration.listening) return;
    registration.requestSignal.removeEventListener("abort", registration.onRequestAbort);
    registration.listening = false;
  }

  async run<T>(
    requestSignal: AbortSignal,
    operation: TrackedOperation<T>,
  ): Promise<T> {
    if (this.closing) throw new HttpError(503, SHUTDOWN_MESSAGE);

    const controller = new AbortController();
    const registration: OperationRegistration = {
      controller,
      requestSignal,
      onRequestAbort: () => controller.abort(requestSignal.reason),
      listening: false,
    };

    if (requestSignal.aborted) {
      controller.abort(requestSignal.reason);
    } else {
      requestSignal.addEventListener("abort", registration.onRequestAbort, { once: true });
      registration.listening = true;
    }
    this.registrations.add(registration);

    // Deferring invocation by one microtask lets the promise be registered before
    // user code runs, including user code that initiates application shutdown.
    const task = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    });
    this.activeOperations.set(task, registration);

    try {
      return await task;
    } finally {
      this.detachRequestSignal(registration);
      this.registrations.delete(registration);
      this.activeOperations.delete(task);
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.closing = true;
    const reason = new HttpError(503, SHUTDOWN_MESSAGE);
    for (const registration of this.registrations) {
      this.detachRequestSignal(registration);
      registration.controller.abort(reason);
    }
    const activeOperations = [...this.activeOperations.entries()];
    this.shutdownPromise = Promise.allSettled(activeOperations.map(([task]) => task)).then(
      (results) => {
        const failures = results.flatMap((result, index) => {
          if (result.status !== "rejected") return [];
          const registration = activeOperations[index]?.[1];
          return registration && result.reason === registration.controller.signal.reason
            ? []
            : [result.reason];
        });
        if (failures.length) {
          throw new AggregateError(failures, "Provisioning shutdown was incomplete");
        }
      },
    );
    return this.shutdownPromise;
  }
}
