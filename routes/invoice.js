const express = require("express");
const mongoose = require("mongoose");
const Document = require("../models/Document");
const Job = require("../models/Job");
const Invoice = require("../models/Invoice");
const pipelineQueue = require("../queues/pipelineQueue");

const router = express.Router();

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
        const resolvedUserId = userId || "6aa9212244485686077972cd";

        if (!mongoose.Types.ObjectId.isValid(resolvedUserId)) {
            return res.status(400).json({ message: "Invalid userId" });
        }

        // Verify the document exists and has been fully processed
        const document = await Document.findById(documentId).lean();

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

        const invoice = await Invoice.findById(invoiceId).lean();

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

module.exports = router;
