const express = require("express");
const mongoose = require("mongoose");
const Document = require("../models/Document");
const Job = require("../models/Job");
const Invoice = require("../models/Invoice");
const Batch = require("../models/Batch");
const pipelineQueue = require("../queues/pipelineQueue");
const { validateInvoiceData } = require("../utils/invoiceValidator");
const { getNormalizedIdentityKey } = require("../utils/invoiceDuplicate");
const redisConnection = require("../config/redis");
const auth = require("../middleware/auth");

const router = express.Router();

router.use(auth);

const multer = require("multer");
const upload = multer({ dest: "uploads/" });

// ---------------------------------------------------------------------------
// GET /api/invoice/dashboard/stats
// Returns compact statistics for the Invoice Dashboard.
// ---------------------------------------------------------------------------
router.get("/dashboard/stats", async (req, res) => {
    try {
        const resolvedUserId = req.user._id;
        const userIdObj = new mongoose.Types.ObjectId(resolvedUserId);

        const result = await Invoice.aggregate([
            { $match: { userId: userIdObj } },
            {
                $facet: {
                    totalInvoices: [{ $count: "count" }],
                    pendingReview: [
                        { $match: { "review.status": "pending" } },
                        { $count: "count" }
                    ],
                    approved: [
                        { $match: { "review.status": "approved" } },
                        { $count: "count" }
                    ],
                    rejected: [
                        { $match: { "review.status": "rejected" } },
                        { $count: "count" }
                    ],
                    failed: [
                        { $match: { status: "failed" } },
                        { $count: "count" }
                    ],
                    duplicates: [
                        { $match: { "duplicate.isPossibleDuplicate": true } },
                        { $count: "count" }
                    ]
                }
            }
        ]);

        const stats = {
            totalInvoices: 0,
            pendingReview: 0,
            approved: 0,
            rejected: 0,
            failed: 0,
            duplicates: 0
        };

        if (result && result.length > 0) {
            const data = result[0];
            stats.totalInvoices = data.totalInvoices[0] ? data.totalInvoices[0].count : 0;
            stats.pendingReview = data.pendingReview[0] ? data.pendingReview[0].count : 0;
            stats.approved = data.approved[0] ? data.approved[0].count : 0;
            stats.rejected = data.rejected[0] ? data.rejected[0].count : 0;
            stats.failed = data.failed[0] ? data.failed[0].count : 0;
            stats.duplicates = data.duplicates[0] ? data.duplicates[0].count : 0;
        }

        return res.status(200).json(stats);
    } catch (error) {
        console.error("Dashboard stats error:", error.message);
        return res.status(500).json({ 
            error: {
                code: "INTERNAL_ERROR",
                message: "An unexpected error occurred"
            }
        });
    }
});

// ---------------------------------------------------------------------------
// GET /api/invoice/dashboard/invoices
// Returns a paginated, filterable, and sortable list of invoices.
// ---------------------------------------------------------------------------
router.get("/dashboard/invoices", async (req, res) => {
    try {
        const resolvedUserId = req.user._id;

        // 1. Pagination validation
        let page = 1;
        let limit = 10;
        if (req.query.page) {
            page = parseInt(req.query.page, 10);
            if (isNaN(page) || page < 1) {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid page parameter" } });
            }
        }
        if (req.query.limit) {
            limit = parseInt(req.query.limit, 10);
            if (isNaN(limit) || limit < 1 || limit > 100) {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid limit parameter. Must be between 1 and 100." } });
            }
        }

        const skip = (page - 1) * limit;

        // 2. Build Filter
        const filter = { userId: new mongoose.Types.ObjectId(resolvedUserId) };

        // Search
        if (req.query.search && typeof req.query.search === "string") {
            const searchRegex = new RegExp(req.query.search.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
            filter.$or = [
                { "invoiceNumber.value": searchRegex },
                { "vendor.value": searchRegex }
            ];
        }

        // Status filter
        if (req.query.status) {
            const validStatuses = ["extracting", "extracted", "failed"];
            if (!validStatuses.includes(req.query.status)) {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid status parameter" } });
            }
            filter.status = req.query.status;
        }

        // Review Status filter
        if (req.query.reviewStatus) {
            const validReviewStatuses = ["pending", "in_review", "approved", "rejected"];
            if (!validReviewStatuses.includes(req.query.reviewStatus)) {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid reviewStatus parameter" } });
            }
            filter["review.status"] = req.query.reviewStatus;
        }

        // Duplicate filter
        if (req.query.duplicate !== undefined) {
            if (req.query.duplicate !== "true" && req.query.duplicate !== "false") {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid duplicate parameter. Must be true or false." } });
            }
            filter["duplicate.isPossibleDuplicate"] = req.query.duplicate === "true";
        }

        // 3. Sorting validation
        let sortBy = req.query.sortBy || "createdAt";
        let sortOrder = req.query.sortOrder || "desc";

        const validSortFields = {
            "createdAt": "createdAt",
            "updatedAt": "updatedAt",
            "date": "date.value",
            "total": "total.value",
            "invoiceNumber": "invoiceNumber.value",
            "vendor": "vendor.value"
        };

        if (!validSortFields[sortBy]) {
            return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid sortBy parameter" } });
        }
        
        if (sortOrder !== "asc" && sortOrder !== "desc") {
            return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid sortOrder parameter" } });
        }

        const sortConfig = {};
        sortConfig[validSortFields[sortBy]] = sortOrder === "asc" ? 1 : -1;
        // ensure deterministic sorting
        if (sortBy !== "createdAt") sortConfig["createdAt"] = -1;

        // 4. Projection (Compact response)
        const projection = {
            "invoiceNumber.value": 1,
            "vendor.value": 1,
            "date.value": 1,
            "tax.value": 1,
            "total.value": 1,
            "status": 1,
            "validation.isValid": 1,
            "validation.missingFields": 1,
            "validation.errors": 1,
            "validation.warnings": 1,
            "duplicate.isPossibleDuplicate": 1,
            "duplicate.status": 1,
            "review.status": 1,
            "review.reviewedAt": 1,
            "batchId": 1,
            "createdAt": 1,
            "updatedAt": 1
        };

        // 5. Execute Queries
        const total = await Invoice.countDocuments(filter);
        
        let invoices = [];
        if (total > 0) {
            invoices = await Invoice.find(filter)
                .sort(sortConfig)
                .skip(skip)
                .limit(limit)
                .select(projection)
                .lean();
        }

        // 6. Format Response
        const formattedInvoices = invoices.map(inv => {
            return {
                invoiceId: inv._id,
                invoiceNumber: inv.invoiceNumber?.value || null,
                vendor: inv.vendor?.value || null,
                date: inv.date?.value || null,
                tax: inv.tax?.value || null,
                total: inv.total?.value || null,
                status: inv.status,
                validation: {
                    isValid: inv.validation?.isValid || false,
                    missingFields: inv.validation?.missingFields || [],
                    errorCount: inv.validation?.errors ? inv.validation.errors.length : 0,
                    warningCount: inv.validation?.warnings ? inv.validation.warnings.length : 0
                },
                duplicate: {
                    isPossibleDuplicate: inv.duplicate?.isPossibleDuplicate || false,
                    status: inv.duplicate?.status || "not_duplicate"
                },
                review: {
                    status: inv.review?.status || "pending",
                    reviewedAt: inv.review?.reviewedAt || null
                },
                batchId: inv.batchId || null,
                createdAt: inv.createdAt,
                updatedAt: inv.updatedAt
            };
        });

        return res.status(200).json({
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            invoices: formattedInvoices
        });

    } catch (error) {
        console.error("Dashboard invoices error:", error.message);
        return res.status(500).json({ 
            error: {
                code: "INTERNAL_ERROR",
                message: "An unexpected error occurred"
            }
        });
    }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/invoice/batch
// Uploads multiple invoice PDFs and chains the processing pipeline.
// ---------------------------------------------------------------------------
router.post("/batch", upload.array("pdfs", 50), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "PDF files are required" } });
        }
        
        for (const file of req.files) {
            if (file.mimetype !== "application/pdf") {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Only PDF files are allowed" } });
            }
            if (file.size > 10 * 1024 * 1024) {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "File size exceeds 10 MB limit" } });
            }
        }

        const resolvedUserId = req.user._id;

        const batch = await Batch.create({
            userId: resolvedUserId,
            totalInvoices: req.files.length,
            processedInvoices: 0,
            successfulInvoices: 0,
            failedInvoices: 0,
            status: "pending"
        });

        for (const file of req.files) {
            const document = await Document.create({
                userId: resolvedUserId,
                originalName: file.originalname,
                filePath: file.path,
                mimeType: file.mimetype,
                fileSize: file.size,
                batchId: batch._id
            });

            const job = await Job.create({
                userId: resolvedUserId,
                documentId: document._id,
                status: "pending",
                batchId: batch._id
            });

            const invoice = await Invoice.create({
                userId: resolvedUserId,
                documentId: document._id,
                jobId: job._id,
                status: "extracting",
                batchId: batch._id
            });

            const bullJob = await pipelineQueue.add(
                "process-pdf",
                {
                    documentId: document._id.toString(),
                    filePath: file.path,
                    autoExtract: true,
                    jobId: job._id.toString(),
                    invoiceId: invoice._id.toString(),
                    userId: resolvedUserId.toString(),
                    batchId: batch._id.toString()
                },
                {
                    attempts: 3,
                    backoff: { type: "exponential", delay: 2000 }
                }
            );

            job.bullJobId = bullJob.id;
            await job.save();
        }

        return res.status(202).json({
            message: "Batch processing started",
            batchId: batch._id,
            totalInvoices: batch.totalInvoices,
            status: batch.status
        });
    } catch (error) {
        console.error("Batch upload error:", error.message);
        return res.status(500).json({ 
            error: {
                code: "INTERNAL_ERROR",
                message: "Failed to upload batch"
            }
        });
    }
});

// ---------------------------------------------------------------------------
// GET /api/invoice/batches
// Returns a paginated list of batches.
// ---------------------------------------------------------------------------
router.get("/batches", async (req, res) => {
    try {
        const resolvedUserId = req.user._id;

        let page = 1;
        let limit = 10;
        if (req.query.page) {
            page = parseInt(req.query.page, 10);
            if (isNaN(page) || page < 1) {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid page parameter" } });
            }
        }
        if (req.query.limit) {
            limit = parseInt(req.query.limit, 10);
            if (isNaN(limit) || limit < 1 || limit > 100) {
                return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid limit parameter" } });
            }
        }

        const skip = (page - 1) * limit;
        const filter = { userId: new mongoose.Types.ObjectId(resolvedUserId) };

        const total = await Batch.countDocuments(filter);
        
        let batches = [];
        if (total > 0) {
            batches = await Batch.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select({
                    status: 1,
                    totalInvoices: 1,
                    processedInvoices: 1,
                    successfulInvoices: 1,
                    failedInvoices: 1,
                    errorMessage: 1,
                    createdAt: 1,
                    updatedAt: 1
                })
                .lean();
        }

        const formattedBatches = batches.map(b => ({
            batchId: b._id,
            status: b.status,
            totalInvoices: b.totalInvoices,
            processedInvoices: b.processedInvoices,
            successfulInvoices: b.successfulInvoices,
            failedInvoices: b.failedInvoices,
            errorMessage: b.errorMessage,
            createdAt: b.createdAt,
            updatedAt: b.updatedAt
        }));

        return res.status(200).json({
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            batches: formattedBatches
        });

    } catch (error) {
        console.error("List batches error:", error.message);
        return res.status(500).json({ 
            error: {
                code: "INTERNAL_ERROR",
                message: "Failed to list batches"
            }
        });
    }
});

// ---------------------------------------------------------------------------
// GET /api/invoice/batch/:batchId
// Returns the status of a specific batch.
// ---------------------------------------------------------------------------
router.get("/batch/:batchId", async (req, res) => {
    try {
        const { batchId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(batchId)) {
            return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid batchId" } });
        }

        const resolvedUserId = req.user._id;

        const batch = await Batch.findOne({ 
            _id: batchId, 
            userId: resolvedUserId 
        }).lean();

        if (!batch) {
            return res.status(404).json({ error: { code: "NOT_FOUND", message: "Batch not found" } });
        }

        return res.status(200).json({
            batchId: batch._id,
            status: batch.status,
            totalInvoices: batch.totalInvoices,
            processedInvoices: batch.processedInvoices,
            successfulInvoices: batch.successfulInvoices,
            failedInvoices: batch.failedInvoices,
            errorMessage: batch.errorMessage,
            createdAt: batch.createdAt,
            updatedAt: batch.updatedAt
        });
    } catch (error) {
        console.error("Get batch error:", error.message);
        return res.status(500).json({ 
            error: {
                code: "INTERNAL_ERROR",
                message: "Failed to fetch batch"
            }
        });
    }
});

// ---------------------------------------------------------------------------
// POST /api/invoice/batch/:batchId/retry-failed
// Retries failed invoices within a batch.
// ---------------------------------------------------------------------------
router.post("/batch/:batchId/retry-failed", async (req, res) => {
    try {
        const { batchId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(batchId)) {
            return res.status(400).json({ error: { code: "INVALID_PARAMETER", message: "Invalid batchId" } });
        }

        const resolvedUserId = req.user._id;

        const batch = await Batch.findOne({ 
            _id: batchId, 
            userId: resolvedUserId 
        });

        if (!batch) {
            return res.status(404).json({ error: { code: "NOT_FOUND", message: "Batch not found" } });
        }

        const failedInvoices = await Invoice.find({
            batchId: batch._id,
            userId: resolvedUserId,
            status: "failed"
        });

        if (failedInvoices.length === 0) {
            return res.status(200).json({
                message: "No failed invoices found to retry",
                retriedCount: 0
            });
        }

        let retriedCount = 0;
        
        for (const invoice of failedInvoices) {
            const document = await Document.findOne({ _id: invoice.documentId });
            const job = await Job.findOne({ _id: invoice.jobId });
            
            if (!document || !job) {
                console.error(`Cannot retry invoice ${invoice._id}: missing document or job`);
                continue;
            }

            job.status = "pending";
            await job.save();

            invoice.status = "extracting";
            invoice.validation = undefined;
            await invoice.save();

            const bullJob = await pipelineQueue.add(
                "process-pdf",
                {
                    documentId: document._id.toString(),
                    filePath: document.filePath,
                    autoExtract: true,
                    jobId: job._id.toString(),
                    invoiceId: invoice._id.toString(),
                    userId: resolvedUserId.toString(),
                    batchId: batch._id.toString()
                },
                {
                    attempts: 3,
                    backoff: { type: "exponential", delay: 2000 }
                }
            );

            job.bullJobId = bullJob.id;
            await job.save();
            
            retriedCount++;
        }

        batch.processedInvoices = Math.max(0, batch.processedInvoices - retriedCount);
        batch.failedInvoices = Math.max(0, batch.failedInvoices - retriedCount);
        batch.status = "processing";
        await batch.save();

        return res.status(202).json({
            message: "Retry started for failed invoices",
            batchId: batch._id,
            retriedCount
        });
    } catch (error) {
        console.error("Retry batch error:", error.message);
        return res.status(500).json({ 
            error: {
                code: "INTERNAL_ERROR",
                message: "Failed to retry batch"
            }
        });
    }
});

// POST /api/invoice/upload
// Uploads a single invoice PDF and auto-chains the processing pipeline.
// ---------------------------------------------------------------------------
router.post("/upload", upload.single("pdf"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "PDF file is required" });
        }
        if (req.file.mimetype !== "application/pdf") {
            return res.status(400).json({ message: "Only PDF files are allowed" });
        }
        if (req.file.size > 10 * 1024 * 1024) {
            return res.status(400).json({ message: "File size exceeds 10 MB limit" });
        }

        const resolvedUserId = req.user._id;

        const document = await Document.create({
            userId: resolvedUserId,
            originalName: req.file.originalname,
            filePath: req.file.path,
            mimeType: req.file.mimetype,
            fileSize: req.file.size,
            batchId: null
        });

        const job = await Job.create({
            userId: resolvedUserId,
            documentId: document._id,
            status: "pending",
            batchId: null
        });

        const invoice = await Invoice.create({
            userId: resolvedUserId,
            documentId: document._id,
            jobId: job._id,
            status: "extracting",
            batchId: null
        });
        
        const bullJob = await pipelineQueue.add(
            "process-pdf",
            {
                documentId: document._id.toString(),
                filePath: req.file.path,
                autoExtract: true,
                jobId: job._id.toString(),
                invoiceId: invoice._id.toString(),
                userId: resolvedUserId.toString(),
                batchId: null
            },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 2000 }
            }
        );

        job.bullJobId = bullJob.id;
        await job.save();

        return res.status(202).json({
            message: "Invoice processing started",
            invoiceId: invoice._id,
            documentId: document._id,
            jobId: job._id,
            status: "pending"
        });
    } catch (error) {
        console.error("Single invoice upload error:", error.message);
        return res.status(500).json({ message: "Failed to upload invoice" });
    }
});

// ---------------------------------------------------------------------------
// GET /api/invoice/:invoiceId/status
// Read-only endpoint for checking the processing status of a single invoice.
// ---------------------------------------------------------------------------
router.get("/:invoiceId/status", async (req, res) => {
    try {
        const { invoiceId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const resolvedUserId = req.user._id;

        const invoice = await Invoice.findOne({ 
            _id: invoiceId, 
            userId: resolvedUserId 
        }).lean();

        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        const job = await Job.findOne({ _id: invoice.jobId, userId: resolvedUserId }).lean();
        
        let overallStatus = "processing";
        if (job) {
            if (job.status === "failed" || invoice.status === "failed") {
                overallStatus = "failed";
            } else if (job.status === "completed" && invoice.status === "extracted") {
                overallStatus = "completed";
            } else if (job.status === "pending" && invoice.status === "extracting") {
                overallStatus = "queued";
            }
        } else if (invoice.status === "failed") {
            overallStatus = "failed";
        } else if (invoice.status === "extracted") {
            overallStatus = "completed";
        }

        return res.status(200).json({
            invoiceId: invoice._id,
            jobId: invoice.jobId,
            status: overallStatus,
            invoiceStatus: invoice.status,
            reviewStatus: invoice.review ? invoice.review.status : "pending",
            validation: invoice.validation || {
                isValid: true,
                errorCount: 0,
                warningCount: 0
            },
            duplicate: invoice.duplicate || {
                isPossibleDuplicate: false,
                status: "not_duplicate"
            }
        });
    } catch (error) {
        console.error("Get invoice status error:", error.message);
        return res.status(500).json({ message: "Failed to fetch status" });
    }
});

// ---------------------------------------------------------------------------
// POST /api/invoice/extract
// Accepts { documentId } for a PDF that has already been processed by
// the existing process-pdf pipeline.  Creates a Job + Invoice placeholder
// and enqueues a process-invoice BullMQ job.
// ---------------------------------------------------------------------------
router.post("/extract", async (req, res) => {
    try {
        const { documentId, userId } = req.body;

        if (!documentId) {
            return res.status(400).json({ message: "documentId is required" });
        }

        if (!mongoose.Types.ObjectId.isValid(documentId)) {
            return res.status(400).json({ message: "Invalid documentId" });
        }

        // Resolve userId: accept from body or fall back to the dev placeholder
        // that already exists in the project (same pattern as routes/pdf.js).
        const resolvedUserId = req.user._id;

        if (!mongoose.Types.ObjectId.isValid(resolvedUserId)) {
            return res.status(400).json({ message: "Invalid userId" });
        }

        // Verify the document exists and has been fully processed
        const document = await Document.findOne({ _id: documentId, userId: req.user._id }).lean();

        if (!document) {
            return res.status(404).json({ message: "Document not found" });
        }

        if (document.status !== "completed") {
            return res.status(409).json({
                message: `Document is not ready for extraction (status: ${document.status})`
            });
        }

        // Prevent duplicate extraction submissions for the same document
        const existing = await Invoice.findOne({ documentId }).lean();
        if (existing) {
            return res.status(409).json({
                message: "An invoice has already been extracted for this document",
                invoiceId: existing._id
            });
        }

        // Create the generic Job record (reuses existing mechanism)
        const job = await Job.create({
            userId: resolvedUserId,
            status: "pending"
        });

        // Create the Invoice placeholder so the documentId unique index fires
        // immediately (prevents race-condition double submissions)
        const invoice = await Invoice.create({
            userId: resolvedUserId,
            documentId,
            jobId: job._id,
            status: "extracting"
        });

        // Enqueue the BullMQ job
        const bullJob = await pipelineQueue.add(
            "process-invoice",
            {
                jobId: job._id.toString(),
                invoiceId: invoice._id.toString(),
                documentId: documentId.toString(),
                userId: resolvedUserId.toString()
            },
            {
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 2000
                }
            }
        );

        // Store the BullMQ job id on the Job record
        job.bullJobId = bullJob.id;
        await job.save();

        return res.status(201).json({
            message: "Invoice extraction job created",
            jobId: job._id,
            invoiceId: invoice._id
        });
    } catch (error) {
        console.error("Invoice extract error:", error.message);

        // Duplicate index violation from MongoDB
        if (error.code === 11000) {
            return res.status(409).json({
                message: "An invoice has already been submitted for this document"
            });
        }

        return res.status(500).json({ message: "Failed to create invoice extraction job" });
    }
});

// ---------------------------------------------------------------------------
// GET /api/invoice/:invoiceId
// Retrieve a saved invoice and its linked job status.
// ---------------------------------------------------------------------------
router.get("/:invoiceId", async (req, res) => {
    try {
        const { invoiceId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id }).lean();

        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        // Fetch linked job status so the caller can poll a single endpoint
        const job = await Job.findById(invoice.jobId).lean();

        return res.status(200).json({
            invoiceId: invoice._id,
            documentId: invoice.documentId,
            status: invoice.status,
            errorMessage: invoice.errorMessage || null,
            invoiceNumber: invoice.invoiceNumber,
            vendor: invoice.vendor,
            date: invoice.date,
            tax: invoice.tax,
            total: invoice.total,
            lineItems: invoice.lineItems,
            job: job
                ? {
                      jobId: job._id,
                      status: job.status,
                      isCachedResult: job.isCachedResult,
                      extractedData: job.extractedData
                  }
                : null,
            createdAt: invoice.createdAt,
            updatedAt: invoice.updatedAt
        });
    } catch (error) {
        console.error("Get invoice error:", error.message);
        return res.status(500).json({ message: "Failed to fetch invoice" });
    }
});
// ---------------------------------------------------------------------------
// GET /api/invoice/:invoiceId/review
// Retrieve an invoice's AI extraction alongside its human review state.
// ---------------------------------------------------------------------------
router.get("/:invoiceId/review", async (req, res) => {
    try {
        const { invoiceId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id }).lean();

        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        return res.status(200).json({
            invoiceId: invoice._id,
            documentId: invoice.documentId,
            jobId: invoice.jobId,
            
            // Original AI extraction (preserved)
            invoiceNumber: invoice.invoiceNumber,
            vendor: invoice.vendor,
            date: invoice.date,
            tax: invoice.tax,
            total: invoice.total,
            lineItems: invoice.lineItems,
            
            // Original AI validation
            validation: invoice.validation,
            
            // Human review state
            review: invoice.review,
            
            status: invoice.status,
            errorMessage: invoice.errorMessage || null,
            createdAt: invoice.createdAt,
            updatedAt: invoice.updatedAt
        });
    } catch (error) {
        console.error("Get invoice review error:", error.message);
        return res.status(500).json({ message: "Failed to fetch invoice review state" });
    }
});
// ---------------------------------------------------------------------------
// PATCH /api/invoice/:invoiceId/review
// Submit human corrections for an invoice.
// ---------------------------------------------------------------------------
router.patch("/:invoiceId/review", async (req, res) => {
    try {
        const { invoiceId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const { corrections, notes } = req.body;
        
        // Reject unknown fields
        const allowedFields = ["invoiceNumber", "vendor", "date", "tax", "total", "lineItems"];
        if (corrections && typeof corrections === "object") {
            const keys = Object.keys(corrections);
            for (const key of keys) {
                if (!allowedFields.includes(key)) {
                    return res.status(400).json({ message: `Unknown correction field: ${key}` });
                }
            }
        }

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id });
        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        // Check review status
        if (invoice.review.status === "approved") {
            return res.status(409).json({ message: "Cannot modify an approved invoice." });
        }

        // Update notes if provided
        if (notes !== undefined) {
            invoice.review.notes = notes;
        }

        // Apply corrections
        if (corrections && typeof corrections === "object") {
            for (const [key, value] of Object.entries(corrections)) {
                if (value === null) {
                    // Remove field from corrections so it falls back to original
                    invoice.review.corrections[key] = null;
                } else {
                    // Apply explicit correction
                    invoice.review.corrections[key] = value;
                }
            }
        }

        // Compute effective values for validation
        const effectiveData = {
            invoiceNumber: { value: invoice.review.corrections.invoiceNumber !== null ? invoice.review.corrections.invoiceNumber : invoice.invoiceNumber.value },
            vendor: { value: invoice.review.corrections.vendor !== null ? invoice.review.corrections.vendor : invoice.vendor.value },
            date: { value: invoice.review.corrections.date !== null ? invoice.review.corrections.date : invoice.date.value },
            tax: { value: invoice.review.corrections.tax !== null ? invoice.review.corrections.tax : invoice.tax.value },
            total: { value: invoice.review.corrections.total !== null ? invoice.review.corrections.total : invoice.total.value },
            lineItems: invoice.review.corrections.lineItems !== null ? invoice.review.corrections.lineItems : invoice.lineItems
        };

        // Recalculate review validation
        invoice.review.validation = validateInvoiceData(effectiveData);

        // Recalculate duplicate identity
        const normKey = getNormalizedIdentityKey(effectiveData.vendor.value, effectiveData.invoiceNumber.value);
        if (normKey && invoice.normalizedIdentityKey !== normKey) {
            invoice.normalizedIdentityKey = normKey;
            
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
                        invoice.duplicate = {
                            isPossibleDuplicate: true,
                            duplicateOf: match._id,
                            status: "unresolved"
                        };
                    } else {
                        invoice.duplicate = {
                            isPossibleDuplicate: false,
                            duplicateOf: null,
                            status: "not_duplicate"
                        };
                    }
                    
                    // Update status
                    if (invoice.review.status === "pending" || invoice.review.status === "rejected") {
                        invoice.review.status = "in_review";
                    }

                    invoice.markModified('review.corrections');
                    await invoice.save();
                }
            } finally {
                if (locked) {
                    await redisConnection.del(lockKey);
                }
            }
        } else {
            // Update status
            if (invoice.review.status === "pending" || invoice.review.status === "rejected") {
                invoice.review.status = "in_review";
            }

            invoice.markModified('review.corrections');
            await invoice.save();
        }

        return res.status(200).json({
            invoiceId: invoice._id,
            
            // Original AI extraction
            aiExtraction: {
                invoiceNumber: invoice.invoiceNumber,
                vendor: invoice.vendor,
                date: invoice.date,
                tax: invoice.tax,
                total: invoice.total,
                lineItems: invoice.lineItems
            },
            
            // Original AI validation
            validation: invoice.validation,
            
            // Human review state
            review: invoice.review,
            
            // Current effective values
            effectiveInvoice: {
                invoiceNumber: effectiveData.invoiceNumber.value,
                vendor: effectiveData.vendor.value,
                date: effectiveData.date.value,
                tax: effectiveData.tax.value,
                total: effectiveData.total.value,
                lineItems: effectiveData.lineItems
            }
        });
    } catch (error) {
        console.error("Patch invoice review error:", error.message);
        return res.status(500).json({ message: "Failed to update invoice corrections" });
    }
});
// ---------------------------------------------------------------------------
// POST /api/invoice/:invoiceId/review/approve
// Approves the human-reviewed invoice based on effective validation state.
// ---------------------------------------------------------------------------
router.post("/:invoiceId/review/approve", async (req, res) => {
    try {
        const { invoiceId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id });
        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        if (invoice.review.status === "approved") {
            return res.status(409).json({ message: "Invoice is already approved" });
        }

        if (invoice.review.status === "rejected") {
            return res.status(409).json({ message: "Cannot approve a rejected invoice. Please correct it first." });
        }

        if (!invoice.review.validation || invoice.review.validation.isValid !== true) {
            return res.status(400).json({ 
                message: "Cannot approve invoice with unresolved validation errors.",
                validationErrors: invoice.review.validation ? invoice.review.validation.errors : []
            });
        }

        if (invoice.duplicate && invoice.duplicate.isPossibleDuplicate && invoice.duplicate.status !== "not_duplicate") {
            return res.status(409).json({ message: "Cannot approve invoice with unresolved duplicate warning." });
        }

        const resolvedUserId = req.user._id;

        invoice.review.status = "approved";
        invoice.review.reviewedBy = resolvedUserId;
        invoice.review.reviewedAt = new Date();

        await invoice.save();

        const effectiveData = {
            invoiceNumber: { value: invoice.review.corrections.invoiceNumber !== null && invoice.review.corrections.invoiceNumber !== undefined ? invoice.review.corrections.invoiceNumber : invoice.invoiceNumber.value },
            vendor: { value: invoice.review.corrections.vendor !== null && invoice.review.corrections.vendor !== undefined ? invoice.review.corrections.vendor : invoice.vendor.value },
            date: { value: invoice.review.corrections.date !== null && invoice.review.corrections.date !== undefined ? invoice.review.corrections.date : invoice.date.value },
            tax: { value: invoice.review.corrections.tax !== null && invoice.review.corrections.tax !== undefined ? invoice.review.corrections.tax : invoice.tax.value },
            total: { value: invoice.review.corrections.total !== null && invoice.review.corrections.total !== undefined ? invoice.review.corrections.total : invoice.total.value },
            lineItems: invoice.review.corrections.lineItems !== null && invoice.review.corrections.lineItems !== undefined ? invoice.review.corrections.lineItems : invoice.lineItems
        };

        return res.status(200).json({
            invoiceId: invoice._id,
            
            // Original AI extraction
            aiExtraction: {
                invoiceNumber: invoice.invoiceNumber,
                vendor: invoice.vendor,
                date: invoice.date,
                tax: invoice.tax,
                total: invoice.total,
                lineItems: invoice.lineItems
            },
            
            // Original AI validation
            validation: invoice.validation,
            
            // Human review state
            review: invoice.review,
            
            // Current effective values
            effectiveInvoice: {
                invoiceNumber: effectiveData.invoiceNumber.value,
                vendor: effectiveData.vendor.value,
                date: effectiveData.date.value,
                tax: effectiveData.tax.value,
                total: effectiveData.total.value,
                lineItems: effectiveData.lineItems
            }
        });
    } catch (error) {
        console.error("Approve invoice error:", error.message);
        return res.status(500).json({ message: "Failed to approve invoice" });
    }
});
// ---------------------------------------------------------------------------
// POST /api/invoice/:invoiceId/review/reject
// Rejects the human-reviewed invoice.
// ---------------------------------------------------------------------------
router.post("/:invoiceId/review/reject", async (req, res) => {
    try {
        const { invoiceId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const { reason } = req.body;
        if (!reason || typeof reason !== 'string' || reason.trim() === '') {
            return res.status(400).json({ message: "Rejection reason is required." });
        }
        const trimmedReason = reason.trim();

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id });
        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        if (invoice.review.status === "approved") {
            return res.status(409).json({ message: "Invoice is already approved" });
        }

        if (invoice.review.status === "rejected") {
            return res.status(409).json({ message: "Invoice is already rejected" });
        }

        const resolvedUserId = req.user._id;

        invoice.review.status = "rejected";
        invoice.review.notes = trimmedReason;
        invoice.review.reviewedBy = resolvedUserId;
        invoice.review.reviewedAt = new Date();

        await invoice.save();

        const effectiveData = {
            invoiceNumber: { value: invoice.review.corrections.invoiceNumber !== null && invoice.review.corrections.invoiceNumber !== undefined ? invoice.review.corrections.invoiceNumber : invoice.invoiceNumber.value },
            vendor: { value: invoice.review.corrections.vendor !== null && invoice.review.corrections.vendor !== undefined ? invoice.review.corrections.vendor : invoice.vendor.value },
            date: { value: invoice.review.corrections.date !== null && invoice.review.corrections.date !== undefined ? invoice.review.corrections.date : invoice.date.value },
            tax: { value: invoice.review.corrections.tax !== null && invoice.review.corrections.tax !== undefined ? invoice.review.corrections.tax : invoice.tax.value },
            total: { value: invoice.review.corrections.total !== null && invoice.review.corrections.total !== undefined ? invoice.review.corrections.total : invoice.total.value },
            lineItems: invoice.review.corrections.lineItems !== null && invoice.review.corrections.lineItems !== undefined ? invoice.review.corrections.lineItems : invoice.lineItems
        };

        return res.status(200).json({
            invoiceId: invoice._id,
            
            // Original AI extraction
            aiExtraction: {
                invoiceNumber: invoice.invoiceNumber,
                vendor: invoice.vendor,
                date: invoice.date,
                tax: invoice.tax,
                total: invoice.total,
                lineItems: invoice.lineItems
            },
            
            // Original AI validation
            validation: invoice.validation,
            
            // Human review state
            review: invoice.review,
            
            // Current effective values
            effectiveInvoice: {
                invoiceNumber: effectiveData.invoiceNumber.value,
                vendor: effectiveData.vendor.value,
                date: effectiveData.date.value,
                tax: effectiveData.tax.value,
                total: effectiveData.total.value,
                lineItems: effectiveData.lineItems
            }
        });
    } catch (error) {
        console.error("Reject invoice error:", error.message);
        return res.status(500).json({ message: "Failed to reject invoice" });
    }
});
// ---------------------------------------------------------------------------
// PATCH /api/invoice/:invoiceId/duplicate
// Resolves a duplicate warning manually.
// ---------------------------------------------------------------------------
router.patch("/:invoiceId/duplicate", async (req, res) => {
    try {
        const { invoiceId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const { status } = req.body;
        if (status !== "confirmed" && status !== "not_duplicate") {
            return res.status(400).json({ message: "Invalid duplicate resolution status" });
        }

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id });
        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        if (!invoice.duplicate || !invoice.duplicate.isPossibleDuplicate) {
            return res.status(409).json({ message: "Invoice is not marked as a possible duplicate" });
        }

        invoice.duplicate.status = status;
        await invoice.save();

        return res.status(200).json({
            invoiceId: invoice._id,
            duplicate: invoice.duplicate
        });
    } catch (error) {
        console.error("Duplicate resolution error:", error.message);
        return res.status(500).json({ message: "Failed to resolve duplicate" });
    }
});
// ---------------------------------------------------------------------------
// GET /api/invoice/:invoiceId/export/json
// Exports the approved invoice as JSON.
// ---------------------------------------------------------------------------
router.get("/:invoiceId/export/json", async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const { download } = req.query;

        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id }).lean();
        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        if (!invoice.review || invoice.review.status !== "approved") {
            return res.status(409).json({ message: "Invoice must be approved before export." });
        }

        const buildFieldAudit = (fieldName) => {
            const isCorrected = invoice.review.corrections[fieldName] !== null && invoice.review.corrections[fieldName] !== undefined;
            return {
                originalAiValue: invoice[fieldName].value,
                isCorrected,
                evidence: invoice[fieldName].evidence,
                page: invoice[fieldName].page
            };
        };

        const effectiveData = {
            invoiceNumber: invoice.review.corrections.invoiceNumber !== null && invoice.review.corrections.invoiceNumber !== undefined ? invoice.review.corrections.invoiceNumber : invoice.invoiceNumber.value,
            vendor: invoice.review.corrections.vendor !== null && invoice.review.corrections.vendor !== undefined ? invoice.review.corrections.vendor : invoice.vendor.value,
            date: invoice.review.corrections.date !== null && invoice.review.corrections.date !== undefined ? invoice.review.corrections.date : invoice.date.value,
            tax: invoice.review.corrections.tax !== null && invoice.review.corrections.tax !== undefined ? invoice.review.corrections.tax : invoice.tax.value,
            total: invoice.review.corrections.total !== null && invoice.review.corrections.total !== undefined ? invoice.review.corrections.total : invoice.total.value,
            lineItems: invoice.review.corrections.lineItems !== null && invoice.review.corrections.lineItems !== undefined ? invoice.review.corrections.lineItems : invoice.lineItems
        };

        const exportJson = {
            invoiceId: invoice._id,
            documentId: invoice.documentId,
            data: effectiveData,
            audit: {
                status: invoice.review.status,
                reviewedBy: invoice.review.reviewedBy,
                reviewedAt: invoice.review.reviewedAt,
                notes: invoice.review.notes,
                fields: {
                    invoiceNumber: buildFieldAudit("invoiceNumber"),
                    vendor: buildFieldAudit("vendor"),
                    date: buildFieldAudit("date"),
                    tax: buildFieldAudit("tax"),
                    total: buildFieldAudit("total"),
                    lineItems: {
                        isCorrected: invoice.review.corrections.lineItems !== null && invoice.review.corrections.lineItems !== undefined
                    }
                },
                validation: {
                    isValid: invoice.review.validation.isValid,
                    warnings: invoice.review.validation.warnings || []
                }
            }
        };

        if (download === "true") {
            res.setHeader("Content-Disposition", `attachment; filename="invoice-${invoice._id}.json"`);
        }

        return res.status(200).json(exportJson);
    } catch (error) {
        console.error("Export invoice JSON error:", error.message);
        return res.status(500).json({ message: "Failed to export invoice as JSON" });
    }
});
// ---------------------------------------------------------------------------
// GET /api/invoice/:invoiceId/export/csv
// Exports the approved invoice as CSV.
// ---------------------------------------------------------------------------
router.get("/:invoiceId/export/csv", async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const { download } = req.query;

        if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
            return res.status(400).json({ message: "Invalid invoiceId" });
        }

        const invoice = await Invoice.findOne({ _id: invoiceId, userId: req.user._id }).lean();
        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        if (!invoice.review || invoice.review.status !== "approved") {
            return res.status(409).json({ message: "Invoice must be approved before export." });
        }

        const effectiveData = {
            invoiceNumber: invoice.review.corrections.invoiceNumber !== null && invoice.review.corrections.invoiceNumber !== undefined ? invoice.review.corrections.invoiceNumber : invoice.invoiceNumber.value,
            vendor: invoice.review.corrections.vendor !== null && invoice.review.corrections.vendor !== undefined ? invoice.review.corrections.vendor : invoice.vendor.value,
            date: invoice.review.corrections.date !== null && invoice.review.corrections.date !== undefined ? invoice.review.corrections.date : invoice.date.value,
            tax: invoice.review.corrections.tax !== null && invoice.review.corrections.tax !== undefined ? invoice.review.corrections.tax : invoice.tax.value,
            total: invoice.review.corrections.total !== null && invoice.review.corrections.total !== undefined ? invoice.review.corrections.total : invoice.total.value,
            lineItems: invoice.review.corrections.lineItems !== null && invoice.review.corrections.lineItems !== undefined ? invoice.review.corrections.lineItems : invoice.lineItems
        };

        const escapeCSV = (val) => {
            if (val === null || val === undefined) return "";
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        const headers = [
            "Invoice ID",
            "Invoice Number",
            "Vendor",
            "Date",
            "Tax",
            "Total",
            "Item Description",
            "Quantity",
            "Unit Price",
            "Amount"
        ];

        let csvLines = [headers.map(escapeCSV).join(",")];

        const baseRow = [
            invoice._id.toString(),
            effectiveData.invoiceNumber,
            effectiveData.vendor,
            effectiveData.date,
            effectiveData.tax,
            effectiveData.total
        ];

        let lineItems = effectiveData.lineItems;
        if (!Array.isArray(lineItems) || lineItems.length === 0) {
            // One row with empty line item columns
            const row = [...baseRow, "", "", "", ""];
            csvLines.push(row.map(escapeCSV).join(","));
        } else {
            for (const item of lineItems) {
                const desc = item.description || item.item || "";
                const qty = item.quantity !== undefined && item.quantity !== null ? item.quantity : "";
                const price = item.unitPrice !== undefined && item.unitPrice !== null ? item.unitPrice : "";
                const amt = item.amount !== undefined && item.amount !== null ? item.amount : "";

                const row = [...baseRow, desc, qty, price, amt];
                csvLines.push(row.map(escapeCSV).join(","));
            }
        }

        const csvContent = csvLines.join("\r\n");

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        if (download === "true") {
            res.setHeader("Content-Disposition", `attachment; filename="invoice-${invoice._id}.csv"`);
        }

        return res.status(200).send(csvContent);
    } catch (error) {
        console.error("Export invoice CSV error:", error.message);
        return res.status(500).json({ message: "Failed to export invoice as CSV" });
    }
});

module.exports = router;

module.exports = router;
