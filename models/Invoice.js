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

        // --- Workflow status ---
        status: {
            type: String,
            enum: ["extracting", "extracted", "failed"],
            default: "extracting"
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

const Invoice = mongoose.model("Invoice", invoiceSchema);

module.exports = Invoice;
