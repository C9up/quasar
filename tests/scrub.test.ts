import { describe, expect, it } from "vitest";
import { scrubError, scrubRejections } from "../src/scrub.js";

/** A reply error as ioredis builds it for a rejected handshake. */
function rejectedHandshake(): Error {
	return Object.assign(new Error("WRONGPASS invalid username-password pair"), {
		command: { name: "hello", args: ["3", "AUTH", "default", "s3cr3t-pw"] },
	});
}

describe("scrubError", () => {
	it("keeps the command's name and drops its arguments, in place", () => {
		const error = rejectedHandshake();
		expect(scrubError(error)).toBe(error);
		expect(Reflect.get(error, "command")).toEqual({ name: "hello" });
		expect(error.message).toBe("WRONGPASS invalid username-password pair");
		expect(JSON.stringify({ ...error })).not.toContain("s3cr3t-pw");
	});

	it("does not touch the arguments array ioredis still holds", () => {
		const args = ["key", "value"];
		const error = Object.assign(new Error("x"), {
			command: { name: "set", args },
		});
		scrubError(error);
		expect(args).toEqual(["key", "value"]);
	});

	it("follows cause, lastNodeError, previousErrors and errors", () => {
		const cause = rejectedHandshake();
		const lastNodeError = rejectedHandshake();
		const previous = rejectedHandshake();
		const aggregated = rejectedHandshake();
		const top = Object.assign(new Error("top", { cause }), {
			lastNodeError,
			previousErrors: [previous, "not an error"],
			errors: [aggregated],
		});
		scrubError(top);
		expect(
			JSON.stringify(
				[cause, lastNodeError, previous, aggregated].map((e) => ({ ...e })),
			),
		).not.toContain("s3cr3t-pw");
	});

	it("stops on a cycle and on a chain deeper than it follows", () => {
		const looped = rejectedHandshake();
		Object.assign(looped, { cause: looped });
		expect(() => scrubError(looped)).not.toThrow();

		let deepest = rejectedHandshake();
		const bottom = deepest;
		for (let i = 0; i < 20; i++)
			deepest = new Error("wrap", { cause: deepest });
		scrubError(deepest);
		expect(Reflect.get(bottom, "command")).toHaveProperty("args");
	});

	it("leaves what it cannot change, and anything that is not an object", () => {
		const frozen = Object.freeze(rejectedHandshake());
		expect(() => scrubError(frozen)).not.toThrow();
		expect(scrubError("text")).toBe("text");
		expect(scrubError(null)).toBeNull();
		const unnamed = Object.assign(new Error("x"), {
			command: { args: ["pw"] },
		});
		expect(Reflect.get(scrubError(unnamed), "command")).toEqual({});
	});
});

describe("scrubRejections", () => {
	function command(): {
		reject: (error: unknown) => void;
		rejected: unknown[];
	} {
		const rejected: unknown[] = [];
		return { rejected, reject: (error) => void rejected.push(error) };
	}

	it("makes a command reject with a scrubbed error, once however often it is sent", () => {
		const sent = command();
		scrubRejections(sent);
		const wrapped = sent.reject;
		scrubRejections(sent);
		expect(sent.reject).toBe(wrapped);
		sent.reject(rejectedHandshake());
		expect(sent.rejected).toHaveLength(1);
		expect(Reflect.get(Object(sent.rejected[0]), "command")).toEqual({
			name: "hello",
		});
	});

	it("ignores what is not a command", () => {
		expect(() => scrubRejections(undefined)).not.toThrow();
		const plain = { name: "get" };
		scrubRejections(plain);
		expect(plain).toEqual({ name: "get" });
	});
});
