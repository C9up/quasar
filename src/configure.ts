/**
 * `ream configure @c9up/quasar` — wire Redis connections in one command.
 *
 * The provider alone is not enough: it reads `config/redis.ts`, and a package
 * registered without one falls back to a default that is rarely the one an
 * application wants. Writing both together is what makes `ream add` mean
 * installed AND working.
 */

import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		REDIS_HOST: "127.0.0.1",
		REDIS_PORT: "6379",
		REDIS_PASSWORD: "",
	});

	await codemods.addProvider("@c9up/quasar/provider");
	await codemods.makeUsingStub(stubsRoot, "config/redis.stub");
}
