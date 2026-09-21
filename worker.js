require("dotenv").config();

const { Worker } = require("bullmq");
const redisConnection = require("./config/redis");
const connectDB = require("./config/db");
const Job = require("./models/Job");

const Groq = require("groq-sdk");
const crypto = require("crypto");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const startWorker = async () => {
    await connectDB();

    const worker = new Worker(
        "data-automation",
        async (job) => {
            console.log("Processing job:", job.id);
            console.log("Job data:", job.data);

            const { jobId, input } = job.data;
            const inputHash = crypto
    .createHash("sha256")
    .update(input)
    .digest("hex");

const cacheKey = `ai:text:${inputHash}`;

console.log("Cache key:", cacheKey);

await Job.findByIdAndUpdate(jobId, {
    status: "processing"
});

// Check Redis cache
const cachedResult = await redisConnection.get(cacheKey);

if (cachedResult) {
    console.log("Cache HIT");

    const aiResult = JSON.parse(cachedResult);

    await Job.findByIdAndUpdate(jobId, {
        status: "completed",
        extractedData: aiResult,
        isCachedResult: true
    });

    return {
        success: true,
        cached: true
    };
}

console.log("Cache MISS");

           console.log("Sending data to Groq...");
           
          
            const response = await groq.chat.completions.create({
            model: "openai/gpt-oss-20b",
            messages: [
        {
            role: "user",
            content: `
Extract the important information from the following text.

Return ONLY valid JSON.
Do not use markdown.
Do not add explanations.

Text:
${input}
`
        }
    ]
});

const content = response?.choices?.[0]?.message?.content;

if (!content) {
    throw new Error("Groq returned an empty response");
}

let aiResult;

try {
    aiResult = JSON.parse(content);
} catch (error) {
    console.error("Invalid JSON received from Groq");

    throw new Error("Groq returned invalid JSON");
}
console.log("AI response:", aiResult);

// Save result in Redis for 24 hours
await redisConnection.set(
    cacheKey,
    JSON.stringify(aiResult),
    "EX",
    86400
);

console.log("Result saved to Redis");

await Job.findByIdAndUpdate(jobId, {
    status: "completed",
    extractedData: aiResult,
    isCachedResult: false
});

            return {
                success: true
            };
        },
        {
            connection: redisConnection
        }
    );

    worker.on("completed", (job) => {
        console.log("Job completed:", job.id);
    });

   worker.on("failed", async (job, error) => {
    console.error("Job failed:", job?.id, error.message);

    if (job?.data?.jobId && job.attemptsMade >= job.opts.attempts) {
        await Job.findByIdAndUpdate(job.data.jobId, {
            status: "failed",
            errorMessage: error.message
        });
    }
});
    

    console.log("Worker started...");
};

startWorker();