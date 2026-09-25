const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Job = require("../models/Job");
const pipelineQueue = require("../queues/pipelineQueue");

const router = express.Router();

router.get("/jobs/:jobId", async (req, res) => {
    try {
        const { jobId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(jobId)) {
            return res.status(400).json({
                message: "Invalid jobId"
            });
        }

        const job = await Job.findById(jobId).lean();

        if (!job) {
            return res.status(404).json({
                message: "Job not found"
            });
        }

        return res.status(200).json({
            jobId: job._id.toString(),
            status: job.status,
            tokensUsed: job.tokensUsed,
            isCachedResult: job.isCachedResult,
            extractedData: job.extractedData,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt
        });
    } catch (error) {
        console.error("Get job error:", error.message);

        return res.status(500).json({
            message: "Failed to fetch job"
        });
    }
});

router.post("/process", async (req, res) => {
    try {
        const { userId, input, schema } = req.body;

        if (!userId || !input) {
            return res.status(400).json({
                message: "userId and input are required"
            });
        }
        
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
            return res.status(400).json({
                message: "schema must be a valid object"
            });
        }
        const allowedTypes = [
    "string",
    "number",
    "boolean",
    "date",
    "array"
];
console.log("Received schema:", schema);
for (const [field, type] of Object.entries(schema)) {
    if (!allowedTypes.includes(type)) {
        return res.status(400).json({
            message: `Invalid type '${type}' for field '${field}'`
        });
    }
}

        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        if (!user.canExecuteAIJob()) {
            return res.status(429).json({
                message: "Daily AI job limit reached"
            });
        }

        const job = await Job.create({
            userId: user._id,
            status: "pending"
        });

        const bullJob = await pipelineQueue.add(
    "process-data",
    {
        jobId: job._id.toString(),
        userId: user._id.toString(),
        input,
        schema
    },
    {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 2000
        }
    }
);

        job.bullJobId = bullJob.id;
        await job.save();

        res.status(201).json({
            message: "Job created successfully",
            jobId: job._id
        });

    } catch (error) {
        console.error("Pipeline error:", error.message);

        res.status(500).json({
            message: "Failed to create job"
        });
    }
});

module.exports = router;