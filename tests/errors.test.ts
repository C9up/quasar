import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../src/index.js";

describe("errors", () => {
	it("are exported from the entry as flare exceptions, one class per code", () => {
		const error = new errors.E_INVALID_BYTES_VALUE(["lots"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_INVALID_BYTES_VALUE",
			status: 500,
			message: 'Invalid bytes value "lots"',
		});
		expect(new errors.E_QUASAR_NOT_A_CLUSTER(["main"])).toMatchObject({
			code: "E_QUASAR_NOT_A_CLUSTER",
			status: 500,
		});
		for (const [name, ErrorClass] of Object.entries(errors)) {
			expect(ErrorClass.code).toBe(name);
		}
	});
});
