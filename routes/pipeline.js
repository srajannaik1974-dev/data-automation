const express = require("express");
const User = require("../models/User");
const Job = require("../models/Job");
const pipelineQueue = require("../queues/pipelineQueue");

const router = express.Router();

router.post("/process", async (req, res) => {
    try {
        const { userId, input } = req.body;

        if (!userId || !input) {
            return res.status(400).json({
                message: "userId and input are required"
            });
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
        input
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