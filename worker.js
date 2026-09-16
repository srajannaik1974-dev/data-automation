require("dotenv").config();

const { Worker } = require("bullmq");
const redisConnection = require("./config/redis");

const worker = new Worker(
    "data-automation",
    async (job) => {
        console.log("Processing job:", job.id);
        console.log("Job data:", job.data);

        return {
            success: true,
            message: "Job processed successfully"
        };
    },
    {
        connection: redisConnection
    }
);

worker.on("completed", (job) => {
    console.log("Job completed:", job.id);
});

worker.on("failed", (job, error) => {
    console.error("Job failed:", job?.id, error.message);
});

console.log("Worker started...");