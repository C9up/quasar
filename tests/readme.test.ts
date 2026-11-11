import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("quasar > README", () => {
	it("states each behaviour on its own, without comparing to another framework", () => {
		const readme = readFileSync(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		expect(readme).not.toMatch(/adonis|lucid|japa|upstream/i);
	});
});
