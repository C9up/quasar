/**
 * The event surface of a connection and of the manager.
 *
 * Upstream builds both on Emittery: one payload object per event, `on()`
 * answering an unsubscribe function, `once()` answering a promise, and an
 * `error` event that never throws for want of a listener. This is that
 * subset, without the dependency.
 *
 * Owning it — instead of forwarding ioredis' EventEmitter — is what keeps the
 * listeners quasar itself relies on out of reach: `removeAllListeners()` or
 * `clearListeners()` here only ever drop listeners an application attached.
 */

/**
 * A listener for one event's payload. Declared through a method signature so
 * that a listener typed for one event can be stored beside the others: method
 * parameters are compared bivariantly, function parameters are not.
 */
type Listener<Data> = {
	bivarianceHack(data: Data): unknown;
}["bivarianceHack"];

export class Emitter<Events extends object> {
	readonly #listeners = new Map<
		keyof Events,
		Set<Listener<Events[keyof Events]>>
	>();

	/** Listen to an event; the returned function stops listening. */
	on<Name extends keyof Events>(
		event: Name,
		listener: (data: Events[Name]) => unknown,
	): () => void {
		const listeners = this.#listeners.get(event);
		if (listeners) listeners.add(listener);
		else this.#listeners.set(event, new Set([listener]));
		return () => this.off(event, listener);
	}

	/** Stop one listener. */
	off<Name extends keyof Events>(
		event: Name,
		listener: (data: Events[Name]) => unknown,
	): void {
		const listeners = this.#listeners.get(event);
		listeners?.delete(listener);
		if (listeners?.size === 0) this.#listeners.delete(event);
	}

	/** The payload of the next emission of `event`. */
	once<Name extends keyof Events>(event: Name): Promise<Events[Name]> {
		return new Promise((resolve) => {
			const stop = this.on(event, (data) => {
				stop();
				resolve(data);
			});
		});
	}

	/**
	 * Call every listener of `event` with `data`. Resolves once they all
	 * settled, and rejects with the first failure — as Emittery does.
	 */
	async emit<Name extends keyof Events>(
		event: Name,
		data: Events[Name],
	): Promise<void> {
		const listeners = [...(this.#listeners.get(event) ?? [])];
		await Promise.all(listeners.map(async (listener) => listener(data)));
	}

	/** Drop the listeners of one event, or of every event. */
	clearListeners(event?: keyof Events): void {
		if (event === undefined) this.#listeners.clear();
		else this.#listeners.delete(event);
	}

	/** How many listeners an event has, or all events together. */
	listenerCount(event?: keyof Events): number {
		if (event !== undefined) return this.#listeners.get(event)?.size ?? 0;
		let count = 0;
		for (const listeners of this.#listeners.values()) count += listeners.size;
		return count;
	}

	/**
	 * An emission nobody awaits — what an ioredis event turns into. A failing
	 * listener is handed to {@link listenerFailed} rather than left as an
	 * unhandled rejection.
	 */
	protected notify<Name extends keyof Events>(
		event: Name,
		data: Events[Name],
	): void {
		this.emit(event, data).catch((error: unknown) =>
			this.listenerFailed(error),
		);
	}

	/** Where a listener failure from {@link notify} goes. */
	protected listenerFailed(error: unknown): void {
		console.error("[redis] event listener failed", error);
	}
}
