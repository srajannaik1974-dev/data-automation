const mongoose = require("mongoose");

const pageContentSchema = new mongoose.Schema({
    documentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Document",
        required: true
    },

    pageNumber: {
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
pageContentSchema.index(
    { documentId: 1, pageNumber: 1 },
    { unique: true }
);

const PageContent = mongoose.model("PageContent", pageContentSchema);

module.exports = PageContent;