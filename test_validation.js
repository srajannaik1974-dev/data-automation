require('dotenv').config();
const crypto = require('crypto');
const Redis = require('ioredis');
const mongoose = require('mongoose');
const PageContent = require('./models/PageContent');
const Document = require('./models/Document');
const Invoice = require('./models/Invoice');
const Job = require('./models/Job');


const redis = new Redis(process.env.REDIS_URL);

async function runTest(testName, textContent, injectedGroqOutput) {
    console.log(`\n==================================================\nRunning ${testName}\n==================================================`);
    
    // 1. Prepare Document
    const docId = new mongoose.Types.ObjectId().toString();
    const doc = await Document.create({
        _id: docId,
        userId: '6aa9212244485686077972cd',
        originalName: `${testName}.pdf`,
        filePath: 'mock',
        mimeType: 'application/pdf',
        fileSize: 100,
        totalPages: 1,
        status: 'completed'
    });

    // 2. Prepare PageContent
    await PageContent.create({
        documentId: docId,
        pageNumber: 1,
        text: textContent
    });

    // 3. Inject Redis Cache to mock Groq
    const fullText = `--- Page 1 ---\n${textContent}`;
    const inputHash = crypto.createHash("sha256").update(fullText).digest("hex");
    const cacheKey = `ai:invoice:${inputHash}`;
    await redis.set(cacheKey, JSON.stringify(injectedGroqOutput), "EX", 300);

    const fetchRes = await fetch('http://localhost:5000/api/invoice/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: docId })
    });
    
    const data = await fetchRes.json();
    const { jobId, invoiceId } = data;

    // 5. Wait for Job
    let job;
    while (true) {
        job = await Job.findById(jobId).lean();
        if (job.status === 'completed' || job.status === 'failed') break;
        await new Promise(r => setTimeout(r, 500));
    }

    // 6. Output Result
    const inv = await Invoice.findById(invoiceId).lean();
    console.log(`Job Status: ${job.status}`);
    if (inv) {
        console.log(`Validation isValid: ${inv.validation.isValid}`);
        if (inv.validation.missingFields.length > 0) console.log(`Missing: ${inv.validation.missingFields}`);
        if (inv.validation.errors.length > 0) console.log(`Errors:`, JSON.stringify(inv.validation.errors, null, 2));
        if (inv.validation.warnings.length > 0) console.log(`Warnings:`, JSON.stringify(inv.validation.warnings, null, 2));
    }
}

async function runAll() {
    await mongoose.connect(process.env.MONGODB_URI);

    // TEST 1: Valid invoice
    await runTest("TEST 1: Valid invoice", "Valid invoice text 1", {
        invoiceNumber: "INV-001", invoiceNumber_evidence: "Valid invoice text 1",
        vendor: "Test Vendor", vendor_evidence: "Valid invoice text 1",
        date: "2024-01-01", date_evidence: "Valid invoice text 1",
        tax: 5, tax_evidence: "Valid invoice text 1",
        total: 55, total_evidence: "Valid invoice text 1",
        lineItems: [{ description: "Item", quantity: 2, unitPrice: 25, amount: 50 }]
    });

    // TEST 2: Missing required date
    await runTest("TEST 2: Missing required date", "Missing date text 2", {
        invoiceNumber: "INV-002", invoiceNumber_evidence: "Missing date text 2",
        vendor: "Test Vendor", vendor_evidence: "Missing date text 2",
        date: null, date_evidence: null,
        tax: 5, tax_evidence: "Missing date text 2",
        total: 55, total_evidence: "Missing date text 2",
        lineItems: [{ description: "Item", quantity: 2, unitPrice: 25, amount: 50 }]
    });

    // TEST 3: Negative total
    await runTest("TEST 3: Negative total", "Negative total text 3", {
        invoiceNumber: "INV-003", invoiceNumber_evidence: "Negative total text 3",
        vendor: "Test Vendor", vendor_evidence: "Negative total text 3",
        date: "2024-01-01", date_evidence: "Negative total text 3",
        tax: 5, tax_evidence: "Negative total text 3",
        total: -10, total_evidence: "Negative total text 3",
        lineItems: []
    });

    // TEST 4: Negative tax
    await runTest("TEST 4: Negative tax", "Negative tax text 4", {
        invoiceNumber: "INV-004", invoiceNumber_evidence: "Negative tax text 4",
        vendor: "Test Vendor", vendor_evidence: "Negative tax text 4",
        date: "2024-01-01", date_evidence: "Negative tax text 4",
        tax: -5, tax_evidence: "Negative tax text 4",
        total: 50, total_evidence: "Negative tax text 4",
        lineItems: []
    });

    // TEST 5: Tax greater than total
    await runTest("TEST 5: Tax greater than total", "Tax > total text 5", {
        invoiceNumber: "INV-005", invoiceNumber_evidence: "Tax > total text 5",
        vendor: "Test Vendor", vendor_evidence: "Tax > total text 5",
        date: "2024-01-01", date_evidence: "Tax > total text 5",
        tax: 15, tax_evidence: "Tax > total text 5",
        total: 10, total_evidence: "Tax > total text 5",
        lineItems: []
    });

    // TEST 7: Invalid line item (Test 6 is implicit in Test 1)
    await runTest("TEST 7: Invalid line item", "Invalid line item text 7", {
        invoiceNumber: "INV-007", invoiceNumber_evidence: "Invalid line item text 7",
        vendor: "Test Vendor", vendor_evidence: "Invalid line item text 7",
        date: "2024-01-01", date_evidence: "Invalid line item text 7",
        tax: 5, tax_evidence: "Invalid line item text 7",
        total: 55, total_evidence: "Invalid line item text 7",
        lineItems: [{ description: "Item", quantity: 2, unitPrice: 10, amount: 25 }]
    });

    // TEST 8: Incomplete line item
    await runTest("TEST 8: Incomplete line item", "Incomplete line item text 8", {
        invoiceNumber: "INV-008", invoiceNumber_evidence: "Incomplete line item text 8",
        vendor: "Test Vendor", vendor_evidence: "Incomplete line item text 8",
        date: "2024-01-01", date_evidence: "Incomplete line item text 8",
        tax: 5, tax_evidence: "Incomplete line item text 8",
        total: 55, total_evidence: "Incomplete line item text 8",
        lineItems: [{ description: "Item", quantity: 2, unitPrice: 10, amount: null }]
    });

    // TEST 10: Invalid total (Test 9 is implicit in Test 1)
    await runTest("TEST 10: Invalid total", "Invalid total text 10", {
        invoiceNumber: "INV-010", invoiceNumber_evidence: "Invalid total text 10",
        vendor: "Test Vendor", vendor_evidence: "Invalid total text 10",
        date: "2024-01-01", date_evidence: "Invalid total text 10",
        tax: 5, tax_evidence: "Invalid total text 10",
        total: 60, total_evidence: "Invalid total text 10",
        lineItems: [
            { description: "Item 1", quantity: 1, unitPrice: 20, amount: 20 },
            { description: "Item 2", quantity: 1, unitPrice: 30, amount: 30 }
        ]
    });

    // TEST 11: Missing tax
    await runTest("TEST 11: Missing tax", "Missing tax text 11", {
        invoiceNumber: "INV-011", invoiceNumber_evidence: "Missing tax text 11",
        vendor: "Test Vendor", vendor_evidence: "Missing tax text 11",
        date: "2024-01-01", date_evidence: "Missing tax text 11",
        tax: null, tax_evidence: null,
        total: 50, total_evidence: "Missing tax text 11",
        lineItems: [{ description: "Item 1", quantity: 1, unitPrice: 50, amount: 50 }]
    });

    // TEST 13: Check Evidence fields exist
    console.log(`\n==================================================\nRunning TEST 13: Check Evidence Tracking\n==================================================`);
    const inv13 = await Invoice.findOne({ "invoiceNumber.value": "INV-001" }).lean();
    console.log("Invoice 1 evidence:", inv13.invoiceNumber.evidence);
    console.log("Invoice 1 page:", inv13.invoiceNumber.page);

    await mongoose.disconnect();
    redis.disconnect();
    console.log("Done.");
}

runAll().catch(console.error);
