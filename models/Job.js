const mongoose = require("mongoose");
const jobSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed"],
        default: "pending"
    },

    bullJobId: {
        type: String
    },

    tokensUsed: {
        type: Number,
        default: 0
    },

    errorMessage: {
    type: String,
    default: null
},

    isCachedResult: {
        type: Boolean,
        default: false
    },

    extractedData: {
        type: mongoose.Schema.Types.Mixed
    }
}, {
    timestamps: true
});

const Job = mongoose.model("Job", jobSchema);

module.exports = Job;