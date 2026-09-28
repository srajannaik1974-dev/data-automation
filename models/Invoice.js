const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
    {
        // --- Associations ---
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        documentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Document",
            required: true
        },

        jobId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Job",
            required: true
        },

        // --- Extracted invoice fields ---
        invoiceNumber: {
            value: { type: String, default: null },
            page: { type: Number, default: null },
            evidence: { type: String, default: null }
        },

        vendor: {
            value: { type: String, default: null },
            page: { type: Number, default: null },
            evidence: { type: String, default: null }
        },

        date: {
            value: { type: String, default: null },
            page: { type: Number, default: null },
            evidence: { type: String, default: null }
        },

        tax: {
            value: { type: Number, default: null },
            page: { type: Number, default: null },
            evidence: { type: String, default: null }
        },

        total: {
            value: { type: Number, default: null },
            page: { type: Number, default: null },
            evidence: { type: String, default: null }
        },

        lineItems: {
            type: mongoose.Schema.Types.Mixed,
            default: null
        },

        // --- Validation results ---
        validation: {
            isValid: { type: Boolean, default: true },
            missingFields: [String],
            errors: [
                {
                    field: String,
                    code: String,
                    message: String
                }
            ],
            warnings: [
                {
                    field: String,
                    code: String,
                    message: String
                }
            ]
        },

        // --- Human Review ---
        review: {
            status: {
                type: String,
                enum: ["pending", "in_review", "approved", "rejected"],
                default: "pending"
            },
            reviewedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
                default: null
            },
            reviewedAt: {
                type: Date,
                default: null
            },
            notes: {
                type: String,
                default: null
            },
            corrections: {
                invoiceNumber: { type: String, default: null },
                vendor: { type: String, default: null },
                date: { type: String, default: null },
                tax: { type: Number, default: null },
                total: { type: Number, default: null },
                lineItems: { type: mongoose.Schema.Types.Mixed, default: null }
            },
            validation: {
                isValid: { type: Boolean, default: true },
                missingFields: { type: [String], default: [] },
                errors: {
                    type: [{
                        field: String,
                        code: String,
                        message: String
                    }],
                    default: []
                },
                warnings: {
                    type: [{
                        field: String,
                        code: String,
                        message: String
                    }],
                    default: []
                }
            }
        },

        // --- Workflow status ---
        status: {
            type: String,
            enum: ["extracting", "extracted", "failed"],
            default: "extracting"
        },

        // --- Duplicate Detection ---
        normalizedIdentityKey: {
            type: String,
            default: null
        },
        duplicate: {
            isPossibleDuplicate: { type: Boolean, default: false },
            duplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
            status: { 
                type: String, 
                enum: ["unresolved", "confirmed", "not_duplicate"],
                default: "not_duplicate"
            }
        },

        // --- Optional error detail ---
        errorMessage: {
            type: String,
            default: null
        }
    },
    {
        timestamps: true
    }
);

// One invoice per document
invoiceSchema.index({ documentId: 1 }, { unique: true });

// Dashboard/list queries
invoiceSchema.index({ userId: 1, status: 1 });

// Duplicate detection lookup
// Sparse because legacy invoices won't have it, and we don't want to index nulls unnecessarily
invoiceSchema.index({ normalizedIdentityKey: 1 }, { sparse: true });

const Invoice = mongoose.model("Invoice", invoiceSchema);

module.exports = Invoice;
