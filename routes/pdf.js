const express = require("express");
const multer = require("multer");
const Document = require("../models/Document");
const pipelineQueue = require("../queues/pipelineQueue");

const router = express.Router();

const upload = multer({
    dest: "uploads/"
});

router.post("/upload", upload.single("pdf"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                message: "PDF file is required"
            });
        }

        const document = await Document.create({
            userId: "6aa9212244485686077972cd",
            originalName: req.file.originalname,
            filePath: req.file.path,
            mimeType: req.file.mimetype,
            fileSize: req.file.size
        });
        await pipelineQueue.add("process-pdf", {
    documentId: document._id.toString(),
    filePath: req.file.path
});

        res.status(201).json({
            message: "PDF uploaded successfully",
            documentId: document._id,
            file: req.file
        });

    } catch (error) {
        console.error("PDF upload error:", error.message);

        res.status(500).json({
            message: "Failed to upload PDF"
        });
    }
});

module.exports = router;