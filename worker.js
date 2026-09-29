require("dotenv").config();

const { Worker } = require("bullmq");
const redisConnection = require("./config/redis");
const connectDB = require("./config/db");
const Job = require("./models/Job");
const PageContent = require("./models/PageContent");
const Document = require("./models/Document");
const Chunk = require("./models/Chunk");
const PageImage = require("./models/PageImage");
const Invoice = require("./models/Invoice");
const Batch = require("./models/Batch");
const pipelineQueue = require("./queues/pipelineQueue");
const path = require("path");
const { PNG } = require("pngjs");
const { validateInvoiceData } = require("./utils/invoiceValidator");
const { getNormalizedIdentityKey } = require("./utils/invoiceDuplicate");

const Groq = require("groq-sdk");
const crypto = require("crypto");
const fs = require("fs");
const { PDFParse } = require("pdf-parse");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const allowedSchemaTypes = new Set([
    "string",
    "number",
    "boolean",
    "date",
    "array"
]);

function validateExtractedDataAgainstSchema(data, schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        throw new Error("Schema must be a plain object");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("AI output must be a JSON object");
    }

    for (const [fieldName, expectedType] of Object.entries(schema)) {
        if (!allowedSchemaTypes.has(expectedType)) {
            throw new Error(
                `Unsupported schema type for field "${fieldName}": ${expectedType}`
            );
        }

        const value = data[fieldName];

        if (value === null || value === undefined) {
            continue;
        }

        if (expectedType === "string") {
            if (typeof value !== "string") {
                throw new Error(
                    `Invalid value for field "${fieldName}": expected string`
                );
            }
        } else if (expectedType === "number") {
            if (typeof value !== "number" || Number.isNaN(value)) {
                throw new Error(
                    `Invalid value for field "${fieldName}": expected number`
                );
            }
        } else if (expectedType === "boolean") {
            if (typeof value !== "boolean") {
                throw new Error(
                    `Invalid value for field "${fieldName}": expected boolean`
                );
            }
        } else if (expectedType === "date") {
            if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
                throw new Error(
                    `Invalid value for field "${fieldName}": expected valid date string`
                );
            }
        } else if (expectedType === "array") {
            if (!Array.isArray(value)) {
                throw new Error(
                    `Invalid value for field "${fieldName}": expected array`
                );
            }
        }
    }

    return true;
}

const startWorker = async () => {
    await connectDB();

    const worker = new Worker(
        "data-automation",
        async (job) => {
             if (job.name === "process-pdf") {
            console.log("Processing PDF job:", job.id);

            const { documentId, filePath, autoExtract, jobId, invoiceId, userId, batchId } = job.data;
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
const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfData = new Uint8Array(pdfBuffer);

const pdf = await pdfjsLib.getDocument({
    data: pdfData
}).promise;

const imageOutputDir = path.join(
    "uploads",
    "pdf-images",
    documentId
);

if (!fs.existsSync(imageOutputDir)) {
    fs.mkdirSync(imageOutputDir, { recursive: true });
}

await PageImage.deleteMany({
    documentId: documentId
});

for (
    let pageNumber = 1;
    pageNumber <= pdf.numPages;
    pageNumber++
) {
    const page = await pdf.getPage(pageNumber);

    const operatorList = await page.getOperatorList();

    let imageIndex = 0;

    for (let i = 0; i < operatorList.fnArray.length; i++) {

        const fn = operatorList.fnArray[i];
        const args = operatorList.argsArray[i];

        if (
            fn === pdfjsLib.OPS.paintImageXObject ||
            fn === pdfjsLib.OPS.paintJpegXObject
        ) {

            const imageName = args[0];

            const image = await new Promise((resolve) => {
                page.objs.get(imageName, resolve);
            });

            if (!image || !image.data) {
                continue;
            }

            imageIndex++;

            const png = new PNG({
                width: image.width,
                height: image.height
            });

            png.data = Buffer.from(image.data);

            const fileName =
                `page-${pageNumber}-image-${imageIndex}.png`;

            const imagePath = path.join(
                imageOutputDir,
                fileName
            );

            await new Promise((resolve, reject) => {
                png.pack()
                    .pipe(fs.createWriteStream(imagePath))
                    .on("finish", resolve)
                    .on("error", reject);
            });

            await PageImage.create({
                documentId: documentId,
                pageNumber: pageNumber,
                imageIndex: imageIndex,
                imagePath: imagePath
            });

            console.log(
                `Saved PDF image: page ${pageNumber}, image ${imageIndex}`
            );
        }
    }
}
await Document.findByIdAndUpdate(documentId, {
    status: "completed",
    totalPages: result.total
});

await parser.destroy();

if (autoExtract && jobId && invoiceId && userId) {
    const bullJob = await pipelineQueue.add(
        "process-invoice",
        {
            jobId,
            invoiceId,
            documentId,
            userId,
            batchId
        },
        {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 }
        }
    );
    await Job.findByIdAndUpdate(jobId, { bullJobId: bullJob.id });
}

            return {
                success: true,
                type: "pdf",
                pages: result.total
            };
        }

        // -----------------------------------------------------------------
        // process-invoice — Invoice-specific AI extraction
        // -----------------------------------------------------------------
        if (job.name === "process-invoice") {
            console.log("Processing invoice job:", job.id);

            const { jobId, invoiceId, documentId, userId, batchId } = job.data;

            await Job.findByIdAndUpdate(jobId, { status: "processing" });

            // 1. Verify the document exists
            const document = await Document.findById(documentId).lean();
            if (!document) {
                throw new Error(`Document not found: ${documentId}`);
            }

            // 2. Load page text in page order (cap at 30 pages to avoid
            //    exceeding Groq context limits on very large PDFs)
            const PAGE_CAP = 30;
            const pageContents = await PageContent.find({ documentId })
                .sort({ pageNumber: 1 })
                .limit(PAGE_CAP)
                .lean();

            if (!pageContents || pageContents.length === 0) {
                throw new Error(
                    `No page content found for document: ${documentId}. ` +
                    "Ensure the PDF was processed first."
                );
            }

            // 3. Assemble context — prepend page numbers so AI can cite them
            const fullText = pageContents
                .map(p => `--- Page ${p.pageNumber} ---\n${p.text}`)
                .join("\n\n");

            // 4. Redis cache check with invoice-specific namespace
            const textHash = crypto
                .createHash("sha256")
                .update(fullText)
                .digest("hex");
            const cacheKey = `ai:invoice:${textHash}`;

            console.log("Invoice cache key:", cacheKey);

            const cachedResult = await redisConnection.get(cacheKey);

            let invoiceFields;

            if (cachedResult) {
                console.log("Invoice cache HIT");
                invoiceFields = JSON.parse(cachedResult);

                await Job.findByIdAndUpdate(jobId, { isCachedResult: true });
            } else {
                console.log("Invoice cache MISS — sending to Groq...");

                const invoiceSchema = {
                    invoiceNumber: "string",
                    invoiceNumber_evidence: "string",
                    vendor: "string",
                    vendor_evidence: "string",
                    date: "date",
                    date_evidence: "string",
                    tax: "number",
                    tax_evidence: "string",
                    total: "number",
                    total_evidence: "string",
                    lineItems: "array"
                };

                const response = await groq.chat.completions.create({
                    model: "openai/gpt-oss-20b",
                    messages: [
                        {
                            role: "user",
                            content:
`Extract invoice information from the text below according to the following schema.

Schema:
${JSON.stringify(invoiceSchema, null, 2)}

Rules:
- Return ONLY valid JSON — no markdown, no code fences, no explanations.
- Use the exact field names from the schema.
- If a value is not present in the text, return null for that field.
- For each main field, extract a corresponding _evidence field containing the EXACT substring from the text that justifies the value.
- Do not invent evidence. It must be an exact substring. If not found, return null for the evidence.
- For lineItems, return an array of objects with fields: description, quantity, unitPrice, amount.
- Do not invent information.
- For date fields, return an ISO 8601 date string (YYYY-MM-DD) or null.

Document text:
${fullText}`
                        }
                    ]
                });

                const content = response?.choices?.[0]?.message?.content;

                if (!content) {
                    throw new Error("Groq returned an empty response for invoice extraction");
                }

                // Strip accidental markdown code fences if the model adds them
                const cleaned = content
                    .replace(/^```(?:json)?\s*/i, "")
                    .replace(/\s*```$/i, "")
                    .trim();

                try {
                    invoiceFields = JSON.parse(cleaned);
                } catch (parseErr) {
                    console.error("Invalid JSON from Groq:", cleaned);
                    throw new Error("Groq returned invalid JSON for invoice extraction");
                }

                // 5. Validate against the invoice schema (reuse existing fn)
                validateExtractedDataAgainstSchema(invoiceFields, invoiceSchema);

                // 6. Cache the validated result for 24 hours
                await redisConnection.set(
                    cacheKey,
                    JSON.stringify(invoiceFields),
                    "EX",
                    86400
                );

                console.log("Invoice result cached");
            }

            console.log("Invoice fields flat:", invoiceFields);
            
            // Helper to map flat field to nested structure with page tracking
            const mapField = (fieldName) => {
                const value = invoiceFields[fieldName] ?? null;
                let evidence = invoiceFields[`${fieldName}_evidence`] ?? null;
                let page = null;
                
                if (value !== null && evidence) {
                    // Try to find the exact evidence string in the pageContents
                    const evidenceLower = evidence.toLowerCase().trim();
                    if (evidenceLower) {
                        for (const p of pageContents) {
                            if (p.text && p.text.toLowerCase().includes(evidenceLower)) {
                                page = p.pageNumber;
                                break;
                            }
                        }
                    }
                    if (page === null) {
                        // Evidence not found in text
                        evidence = null;
                    }
                } else {
                    evidence = null;
                }
                
                return { value, page, evidence };
            };
            
            const nestedInvoice = {
                invoiceNumber: mapField("invoiceNumber"),
                vendor: mapField("vendor"),
                date: mapField("date"),
                tax: mapField("tax"),
                total: mapField("total"),
                lineItems: invoiceFields.lineItems ?? []
            };

            // 6.5 Deterministic Validation
            const validation = validateInvoiceData(nestedInvoice);
            nestedInvoice.validation = validation;

            // 6.6 Duplicate Detection
            const normKey = getNormalizedIdentityKey(nestedInvoice.vendor.value, nestedInvoice.invoiceNumber.value);
            let duplicateInfo = {
                isPossibleDuplicate: false,
                duplicateOf: null,
                status: "not_duplicate"
            };

            if (normKey) {
                const lockKey = `lock:duplicate:${normKey}`;
                let locked = false;
                for (let i = 0; i < 15; i++) {
                    const acquired = await redisConnection.set(lockKey, "locked", "NX", "EX", 10);
                    if (acquired) {
                        locked = true;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 200));
                }

                try {
                    if (locked) {
                        const match = await Invoice.findOne({ 
                            normalizedIdentityKey: normKey, 
                            _id: { $ne: invoiceId } 
                        }).sort({ createdAt: -1 }).lean();

                        if (match) {
                            duplicateInfo = {
                                isPossibleDuplicate: true,
                                duplicateOf: match._id,
                                status: "unresolved"
                            };
                        }
                        
                        // 7. Persist the structured invoice (INSIDE THE LOCK)
                        await Invoice.findByIdAndUpdate(invoiceId, {
                            invoiceNumber: nestedInvoice.invoiceNumber,
                            vendor:        nestedInvoice.vendor,
                            date:          nestedInvoice.date,
                            tax:           nestedInvoice.tax,
                            total:         nestedInvoice.total,
                            lineItems:     nestedInvoice.lineItems,
                            validation:    nestedInvoice.validation,
                            review: {
                                status: "pending",
                                reviewedBy: null,
                                reviewedAt: null,
                                notes: null,
                                corrections: {},
                                validation: nestedInvoice.validation
                            },
                            normalizedIdentityKey: normKey,
                            duplicate: duplicateInfo,
                            status:        "extracted"
                        });
                        
                    } else {
                        console.warn(`Could not acquire duplicate lock for ${normKey}`);
                        // Fallback save if we couldn't acquire lock (invoice must still be saved)
                        await Invoice.findByIdAndUpdate(invoiceId, {
                            invoiceNumber: nestedInvoice.invoiceNumber,
                            vendor:        nestedInvoice.vendor,
                            date:          nestedInvoice.date,
                            tax:           nestedInvoice.tax,
                            total:         nestedInvoice.total,
                            lineItems:     nestedInvoice.lineItems,
                            validation:    nestedInvoice.validation,
                            review: {
                                status: "pending",
                                reviewedBy: null,
                                reviewedAt: null,
                                notes: null,
                                corrections: {},
                                validation: nestedInvoice.validation
                            },
                            normalizedIdentityKey: normKey,
                            duplicate: duplicateInfo, // will be unresolved/not_duplicate as initialized
                            status:        "extracted"
                        });
                    }
                } finally {
                    if (locked) {
                        await redisConnection.del(lockKey);
                    }
                }
            } else {
                // If no normKey, just save it normally
                await Invoice.findByIdAndUpdate(invoiceId, {
                    invoiceNumber: nestedInvoice.invoiceNumber,
                    vendor:        nestedInvoice.vendor,
                    date:          nestedInvoice.date,
                    tax:           nestedInvoice.tax,
                    total:         nestedInvoice.total,
                    lineItems:     nestedInvoice.lineItems,
                    validation:    nestedInvoice.validation,
                    review: {
                        status: "pending",
                        reviewedBy: null,
                        reviewedAt: null,
                        notes: null,
                        corrections: {},
                        validation: nestedInvoice.validation
                    },
                    normalizedIdentityKey: null,
                    duplicate: duplicateInfo,
                    status:        "extracted"
                });
            }

            // 8. Mark the Job complete and store extractedData
            await Job.findByIdAndUpdate(jobId, {
                status: "completed",
                extractedData: nestedInvoice,
                isCachedResult: cachedResult ? true : false
            });

            if (batchId) {
                const updatedBatch = await Batch.findByIdAndUpdate(batchId, {
                    $inc: { processedInvoices: 1, successfulInvoices: 1 }
                }, { new: true });
                
                if (updatedBatch && updatedBatch.processedInvoices === updatedBatch.totalInvoices) {
                    let finalStatus = "completed";
                    if (updatedBatch.failedInvoices === updatedBatch.totalInvoices) {
                        finalStatus = "failed";
                    } else if (updatedBatch.failedInvoices > 0) {
                        finalStatus = "partially_completed";
                    }
                    await Batch.findByIdAndUpdate(batchId, { status: finalStatus });
                }
            }

            console.log("Invoice extraction complete for invoiceId:", invoiceId);

            return {
                success: true,
                type: "invoice",
                invoiceId
            };
        }

            console.log("Processing job:", job.id);
            console.log("Job data:", job.data);

            const { jobId, input, schema } = job.data;
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
Extract information from the text according to the following schema.

Schema:
${JSON.stringify(schema, null, 2)}

Rules:
- Return ONLY valid JSON.
- Do not use markdown.
- Do not add explanations.
- Use the exact field names provided in the schema.
- Follow the requested field types.
- If a value is not present in the text, return null.
- Do not invent information.

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

validateExtractedDataAgainstSchema(aiResult, schema);

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

        if (job.data.invoiceId) {
            await Invoice.findByIdAndUpdate(job.data.invoiceId, {
                status: "failed",
                errorMessage: error.message
            });
        }
        
        if (job.data.batchId) {
            const updatedBatch = await Batch.findByIdAndUpdate(job.data.batchId, {
                $inc: { processedInvoices: 1, failedInvoices: 1 }
            }, { new: true });
            
            if (updatedBatch && updatedBatch.processedInvoices === updatedBatch.totalInvoices) {
                let finalStatus = "completed";
                if (updatedBatch.failedInvoices === updatedBatch.totalInvoices) {
                    finalStatus = "failed";
                } else if (updatedBatch.failedInvoices > 0) {
                    finalStatus = "partially_completed";
                }
                await Batch.findByIdAndUpdate(job.data.batchId, { status: finalStatus });
            }
        }
    }
});
    

    console.log("Worker started...");
};

startWorker();