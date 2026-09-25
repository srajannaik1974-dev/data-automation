const mongoose = require("mongoose");

const chunkSchema = new mongoose.Schema({
    documentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Document",
        required: true
    },

    pageNumber: {
        type: Number,
        required: true
    },

    chunkIndex: {
        type: Number,
        required: true
    },

    text: {
        type: String,
        required: true
    }
}, {
    timestamps: true
});

chunkSchema.index(
    { documentId: 1, pageNumber: 1, chunkIndex: 1 },
    { unique: true }
);

const Chunk = mongoose.model("Chunk", chunkSchema);

module.exports = Chunk;