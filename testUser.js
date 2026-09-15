require("dotenv").config();

const connectDB = require("./config/db");
const User = require("./models/User");
const Job = require("./models/Job");

const testModels = async () => {
    try {
        await connectDB();

        const user = await User.create({
            name: "Test User",
            email: `test${Date.now()}@example.com`,
            password: "temporary-password"
        });

        console.log("User created:");
        console.log(user);

        const job = await Job.create({
            userId: user._id
        });

        console.log("Job created:");
        console.log(job);

        console.log("Can execute AI job:", user.canExecuteAIJob());

        user.aiJobsToday = 9;
        console.log("At 9 jobs:", user.canExecuteAIJob());

        user.aiJobsToday = 10;
        console.log("At 10 jobs:", user.canExecuteAIJob());

        process.exit(0);
    } catch (error) {
        console.error("Model test failed:", error.message);
        process.exit(1);
    }
};

testModels();