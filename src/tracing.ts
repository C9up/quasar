/**
 * Diagnostics channels quasar publishes on.
 *
 * NAMED DEVIATION from upstream's `adonisjs.redis.command`: the channel is
 * `quasar.redis.command`, because a channel name is product identity and a
 * subscriber listening to both frameworks in one process must tell them
 * apart. The payload is narrower too: upstream hands over ioredis' Command,
 * arguments included, and those carry keys and values — secrets, personal
 * data. Here a subscriber gets the command's name and the connection's.
 */

import diagnostics_channel from "node:diagnostics_channel";

export interface RedisCommandTracingData {
	/** The command, lowercase as ioredis names it: `get`, `hset`, `eval`. */
	command: string;
	/** The quasar connection that sent it. */
	connection: string;
}

/** Traces every command sent through a quasar connection. */
export const redisCommand = diagnostics_channel.tracingChannel<
	unknown,
	RedisCommandTracingData
>("quasar.redis.command");
