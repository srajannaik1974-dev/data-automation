require("dotenv").config();

const { Worker } = require("bullmq");
const redisConnection = require("./config/redis");
const connectDB = require("./config/db");
const Job = require("./models/Job");

const Groq = require("groq-sdk");

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

            await Job.findByIdAndUpdate(jobId, {
                status: "processing"
            });

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

const aiResult = JSON.parse(response.choices[0].message.content);
console.log("AI response:", aiResult);

await Job.findByIdAndUpdate(jobId, {
    status: "completed",
    extractedData: aiResult
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

    worker.on("failed", (job, error) => {
        console.error("Job failed:", job?.id, error.message);
    });

    console.log("Worker started...");
};

startWorker();