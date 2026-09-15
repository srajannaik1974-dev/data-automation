const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },

    email: {
        type: String,
        required: true,
        unique: true
    },

    password: {
        type: String,
        required: true
    },

    aiJobsToday: {
        type: Number,
        default: 0
    },
    lastAIJobDate: {
    type: Date,
    default: null
    }
});

userSchema.methods.canExecuteAIJob = function () {
    const today = new Date();

    if (
        !this.lastAIJobDate ||
        this.lastAIJobDate.toDateString() !== today.toDateString()
    ) {
        this.aiJobsToday = 0;
        this.lastAIJobDate = today;
    }

    return this.aiJobsToday < 10;
};

const User = mongoose.model("User", userSchema);

module.exports = User;