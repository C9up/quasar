/**
 * `ream configure @c9up/quasar` — wire Redis connections in one command.
 *
 * The provider alone is not enough: it reads `config/redis.ts`, and a package
 * registered without one falls back to a default that is rarely the one an
 * application wants. Writing both together is what makes `ream add` mean
 * installed AND working.
 */

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/quasar/provider");
	await codemods.writeFile(
		"config/redis.ts",
		`import { defineConfig } from '@c9up/quasar'
import env from '#start/env'

export default defineConfig({
  // The connection \`redis.connection()\` hands back with no argument.
  connection: 'main',

  connections: {
    main: {
      host: env.get('REDIS_HOST', '127.0.0.1'),
      port: Number(env.get('REDIS_PORT', '6379')),
      password: env.get('REDIS_PASSWORD', ''),
    },
  },
})`,
	);
}
