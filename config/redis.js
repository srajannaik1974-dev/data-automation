const Redis = require("ioredis");

const redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
});

redisConnection.on("connect", () => {
    console.log("Redis Connected");
});

redisConnection.on("error", (error) => {
    console.error("Redis connection error:", error.message);
});

module.exports = redisConnection;