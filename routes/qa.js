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

       const stopWords = new Set([
    "what",
    "are",
    "the",
    "is",
    "a",
    "an",
    "of",
    "for",
    "to",
    "in",
    "on",
    "and",
    "or",
    "how",
    "why",
    "who",
    "where",
    "when"
]);

const words = question
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));

        const chunks = await Chunk.find({
    documentId: documentId,
    $or: words.map(word => ({
        text: {
            $regex: word,
            $options: "i"
        }
    }))
});

const scoredChunks = chunks
    .map(chunk => {
        const text = chunk.text.toLowerCase();

       const score = words.reduce((total, word) => {
    if (word === "objectives") {
        return total + (text.includes(word) ? 5 : 0);
    }

    return total + (text.includes(word) ? 1 : 0);
}, 0);

        return {
            chunk,
            score
        };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(item => item.chunk);

       console.log(
    "Scored chunks:",
    scoredChunks.map(chunk => ({
        page: chunk.pageNumber,
        chunk: chunk.chunkIndex,
        text: chunk.text.substring(0, 100)
    }))
);

     const context = scoredChunks
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
    ...new Set(scoredChunks.map(chunk => chunk.pageNumber))
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