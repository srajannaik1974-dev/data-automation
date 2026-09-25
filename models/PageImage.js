const mongoose = require("mongoose");

const pageImageSchema = new mongoose.Schema({
    documentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Document",
        required: true
    },

    pageNumber: {
        type: Number,
        required: true
    },

    imageIndex: {
        type: Number,
        required: true
    },

    imagePath: {
        type: String,
        required: true
    }
}, {
    timestamps: true
});

pageImageSchema.index(
    { documentId: 1, pageNumber: 1, imageIndex: 1 },
    { unique: true }
);

const PageImage = mongoose.model("PageImage", pageImageSchema);

module.exports = PageImage;