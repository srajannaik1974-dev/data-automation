const express = require("express");
const mongoose = require("mongoose");
const Document = require("../models/Document");
const Job = require("../models/Job");
const Invoice = require("../models/Invoice");
const pipelineQueue = require("../queues/pipelineQueue");
const { validateInvoiceData } = require("../utils/invoiceValidator");

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

        const invoice = await Invoice.findById(invoiceId).lean();

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

        const invoice = await Invoice.findById(invoiceId);
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

        // Update status
        if (invoice.review.status === "pending" || invoice.review.status === "rejected") {
            invoice.review.status = "in_review";
        }

        invoice.markModified('review.corrections');
        await invoice.save();

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

        const invoice = await Invoice.findById(invoiceId);
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

        const resolvedUserId = req.body.userId || invoice.userId || "6aa9212244485686077972cd";

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

        const invoice = await Invoice.findById(invoiceId);
        if (!invoice) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        if (invoice.review.status === "approved") {
            return res.status(409).json({ message: "Invoice is already approved" });
        }

        if (invoice.review.status === "rejected") {
            return res.status(409).json({ message: "Invoice is already rejected" });
        }

        const resolvedUserId = req.body.userId || invoice.userId || "6aa9212244485686077972cd";

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

        const invoice = await Invoice.findById(invoiceId).lean();
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

module.exports = router;
