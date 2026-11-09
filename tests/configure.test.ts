/**
 * `ream configure @c9up/quasar`.
 *
 * The hook is what makes `ream add` mean installed AND working: the provider
 * alone reads a config file that would not exist.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configure } from "../src/configure.js";
import { stubRetryStrategy } from "./_support/stubRetryStrategy.js";

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

function fakeCodemods(canValidateEnv = true) {
	const providers: string[] = [];
	const files: Array<{ path: string; content: string }> = [];
	const env: Record<string, string> = {};
	const validations: Array<{
		leadingComment?: string;
		variables: Record<string, string>;
	}> = [];
	return {
		providers,
		files,
		env,
		validations,
		codemods: {
			...(canValidateEnv && {
				async defineEnvValidations(definition: {
					leadingComment?: string;
					variables: Record<string, string>;
				}) {
					validations.push(definition);
					return Object.keys(definition.variables);
				},
			}),
			async addProvider(importPath: string) {
				providers.push(importPath);
			},
			async addEnvVars(vars: Record<string, string>) {
				Object.assign(env, vars);
			},
			async writeFile(path: string, content: string) {
				files.push({ path, content });
			},
			async makeUsingStub(
				stubsRoot: string,
				stubPath: string,
				state: Record<string, string | number | boolean> = {},
			) {
				const { to, body } = renderStub(stubsRoot, stubPath, state);
				files.push({ path: to, content: body });
				return { path: to, contents: body };
			},
		},
	};
}

describe("quasar > configure", () => {
	it("registers the provider and writes the config it reads", async () => {
		const { providers, files, codemods } = fakeCodemods();

		await configure(codemods);

		expect(providers).toEqual(["@c9up/quasar/provider"]);
		expect(files.map((f) => f.path)).toEqual(["config/redis.ts"]);
	});

	it("declares the environment variables the config reads", async () => {
		const { env, files, codemods } = fakeCodemods();

		await configure(codemods);

		// Writing the file without them leaves an application whose config asks
		// the environment for something nothing ever put there.
		expect(env).toHaveProperty("REDIS_HOST");
		for (const key of Object.keys(env)) {
			expect(files[0]?.content).toContain(key);
		}
	});

	it("writes a config that imports from the package it configures", async () => {
		const { files, codemods } = fakeCodemods();

		await configure(codemods);

		// A stub importing the wrong package typechecks nowhere and is the one
		// mistake a generated file must not make.
		expect(files[0]?.content).toContain("from '@c9up/quasar'");
	});

	/**
	 * Upstream's stub bounds the reconnect: ten attempts, 50 ms apart and
	 * growing, then ioredis gives up and the manager reopens on the next call.
	 * Without it every command queued during an outage waited ~74 s.
	 */
	it("writes upstream's bounded retry strategy", async () => {
		const { files, codemods } = fakeCodemods();

		await configure(codemods);
		const retryStrategy = stubRetryStrategy();

		expect(files[0]?.content).toContain("db: 0");
		expect(files[0]?.content).toContain("keyPrefix: ''");
		expect(retryStrategy(1)).toBe(50);
		expect(retryStrategy(10)).toBe(500);
		expect(retryStrategy(11)).toBeNull();
	});

	it("reads the port and the password through the env schema", async () => {
		const { files, codemods } = fakeCodemods();

		await configure(codemods);

		// No `Number(...)`, which turned a typo into NaN and let ioredis fall
		// back to 6379; no `''` default for a password that is a Secret.
		expect(files[0]?.content).toContain("port: env.get('REDIS_PORT')");
		expect(files[0]?.content).toContain("password: env.get('REDIS_PASSWORD')");
	});

	it("declares upstream's validations, the password as a secret", async () => {
		const { validations, codemods } = fakeCodemods();

		await configure(codemods);

		expect(validations).toHaveLength(1);
		expect(validations[0]?.variables).toEqual({
			REDIS_HOST: "Env.schema.string({ format: 'host' })",
			REDIS_PORT: "Env.schema.number()",
			REDIS_PASSWORD: "Env.schema.secret.optional()",
		});
	});

	it("still configures against a ream that cannot write validations", async () => {
		const { providers, files, codemods } = fakeCodemods(false);

		expect("defineEnvValidations" in codemods).toBe(false);
		await configure(codemods);

		expect(providers).toEqual(["@c9up/quasar/provider"]);
		expect(files.map((f) => f.path)).toEqual(["config/redis.ts"]);
	});
});
