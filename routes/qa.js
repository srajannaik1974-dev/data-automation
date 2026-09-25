const express = require("express");
const Chunk = require("../models/Chunk");
const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const router = express.Router();

router.post("/search", async (req, res) => {
    try {
       console.log("Content-Type:", req.headers["content-type"]);
console.log("Request body:", req.body);

const { documentId, question } = req.body || {};
        if (!documentId || !question) {
            return res.status(400).json({
                message: "documentId and question are required"
            });
        }

        const words = question
            .toLowerCase()
            .split(/\s+/)
            .filter(word => word.length > 2);

        const chunks = await Chunk.find({
            documentId: documentId,
            $or: words.map(word => ({
                text: {
                    $regex: word,
                    $options: "i"
                }
            }))
        }).limit(5);
       
       const context = chunks
    .map(chunk => `Page ${chunk.pageNumber}:\n${chunk.text}`)
    .join("\n\n");

const prompt = `
You are answering a question about a PDF.

Use ONLY the information provided in the context below.

If the answer cannot be found in the context, say:
"I could not find the answer in the provided document."

Do not use outside knowledge.

Context:
${context}

Question:
${question}

Give a clear and concise answer.
`;

const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-20b",
    messages: [
        {
            role: "system",
            content: "Answer questions using only the supplied document context."
        },
        {
            role: "user",
            content: prompt
        }
    ]
});

const answer = response?.choices?.[0]?.message?.content;

if (!answer) {
    throw new Error("Groq returned an empty response");
}

const sourcePages = [
    ...new Set(chunks.map(chunk => chunk.pageNumber))
];

res.json({
    question,
    answer,
    sourcePages
});

    } catch (error) {
       console.error("Search error:", error);

res.status(500).json({
    message: "Failed to search document",
    error: error.message
});
    }
});

module.exports = router;