const { Queue } = require("bullmq");
const redisConnection = require("../config/redis");

const pipelineQueue = new Queue("data-automation", {
    connection: redisConnection
});

module.exports = pipelineQueue;