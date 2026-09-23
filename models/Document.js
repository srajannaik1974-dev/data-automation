const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    originalName: {
        type: String,
        required: true
    },

    filePath: {
        type: String,
        required: true
    },

    mimeType: {
        type: String,
        required: true
    },

    fileSize: {
        type: Number,
        required: true
    },

    totalPages: {
        type: Number,
        default: 0
    },

    status: {
        type: String,
        enum: ["uploaded", "processing", "completed", "failed"],
        default: "uploaded"
    }
}, {
    timestamps: true
});

const Document = mongoose.model("Document", documentSchema);

module.exports = Document;