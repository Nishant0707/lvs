import { redis } from "../config/redis.js";
// One expiring lease per socket: another tab disconnecting cannot make a user offline.
const touch = `redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); local before=redis.call('ZCARD',KEYS[1]); redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[1],120); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[4]); return before`;
const drop = `redis.call('ZREM',KEYS[1],ARGV[2]); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1])==0 then return redis.call('ZREM',KEYS[2],ARGV[3]) end; return 0`;
const expire = `redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); if redis.call('ZCARD',KEYS[1])==0 then return redis.call('ZREM',KEYS[2],ARGV[2]) end; return 0`;
export async function touchPresence(userId: string, socketId: string) {
  const now = Date.now();
  return (
    Number(
      await redis.eval(
        touch,
        2,
        `presence:${userId}`,
        "presence:users",
        now,
        now + 60000,
        socketId,
        userId,
      ),
    ) === 0
  );
}
export async function dropPresence(userId: string, socketId: string) {
  return (
    Number(
      await redis.eval(
        drop,
        2,
        `presence:${userId}`,
        "presence:users",
        Date.now(),
        socketId,
        userId,
      ),
    ) === 1
  );
}
export async function isOnline(userId: string) {
  return (
    Number(await redis.zcount(`presence:${userId}`, Date.now() + 1, "+inf")) > 0
  );
}
export async function sweepPresence() {
  const now = Date.now();
  const expired = await redis.zrangebyscore(
    "presence:users",
    "-inf",
    now,
    "LIMIT",
    0,
    1000,
  );
  const offline: string[] = [];
  for (const id of expired)
    if (
      Number(
        await redis.eval(
          expire,
          2,
          `presence:${id}`,
          "presence:users",
          now,
          id,
        ),
      ) === 1
    )
      offline.push(id);
  return offline;
}
