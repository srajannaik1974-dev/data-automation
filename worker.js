require("dotenv").config();

const { Worker } = require("bullmq");
const redisConnection = require("./config/redis");
const connectDB = require("./config/db");
const Job = require("./models/Job");
const PageContent = require("./models/PageContent");
const Document = require("./models/Document");
const Chunk = require("./models/Chunk");

const Groq = require("groq-sdk");
const crypto = require("crypto");
const fs = require("fs");
const { PDFParse } = require("pdf-parse");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const startWorker = async () => {
    await connectDB();

    const worker = new Worker(
        "data-automation",
        async (job) => {
             if (job.name === "process-pdf") {
            console.log("Processing PDF job:", job.id);

            const { documentId, filePath } = job.data;
            await Document.findByIdAndUpdate(documentId, {
    status: "processing"
});

            console.log("Document ID:", documentId);
            console.log("PDF path:", filePath);

            const pdfBuffer = fs.readFileSync(filePath);

            const parser = new PDFParse({
                data: pdfBuffer
            });

       const result = await parser.getText();

console.log("PDF pages:", result.total);
console.log("PDF text length:", result.text.length);

for (let i = 0; i < result.pages.length; i++) {
    const page = result.pages[i];

    await PageContent.create({
        documentId: documentId,
        pageNumber: i + 1,
        text: page.text
    });

    console.log(`Saved page ${i + 1}`);
}
await Chunk.deleteMany({
    documentId: documentId
});

console.log("Old chunks deleted");
const chunkSize = 500;
const overlap = 100;

for (let i = 0; i < result.pages.length; i++) {
    const page = result.pages[i];

    let start = 0;
    let chunkIndex = 0;

    while (start < page.text.length) {

        const chunkText = page.text.slice(
            start,
            start + chunkSize
        );

        await Chunk.create({
            documentId: documentId,
            pageNumber: i + 1,
            chunkIndex: chunkIndex,
            text: chunkText
        });

        console.log(
            `Saved chunk ${chunkIndex} from page ${i + 1}`
        );

        start += chunkSize - overlap;
        chunkIndex++;
    }
}
await Document.findByIdAndUpdate(documentId, {
    status: "completed",
    totalPages: result.total
});

await parser.destroy();

            return {
                success: true,
                type: "pdf",
                pages: result.total
            };
        }
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