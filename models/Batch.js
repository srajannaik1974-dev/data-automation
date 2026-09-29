const mongoose = require("mongoose");

const batchSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        status: {
            type: String,
            enum: ["pending", "processing", "completed", "partially_completed", "failed"],
            default: "pending"
        },
        totalInvoices: {
            type: Number,
            required: true
        },
        processedInvoices: {
            type: Number,
            default: 0
        },
        successfulInvoices: {
            type: Number,
            default: 0
        },
        failedInvoices: {
            type: Number,
            default: 0
        },
        errorMessage: {
            type: String,
            default: null
        }
    },
    {
        timestamps: true
    }
);

batchSchema.index({ userId: 1, createdAt: -1 });
batchSchema.index({ status: 1 });

const Batch = mongoose.model("Batch", batchSchema);

module.exports = Batch;
