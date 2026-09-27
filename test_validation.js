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
    await Document.create({
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

    // 3. Inject Redis Cache if provided (simulating Groq result)
    if (injectedGroqOutput) {
        const fullText = `--- Page 1 ---\n${textContent}`;
        const inputHash = crypto.createHash("sha256").update(fullText).digest("hex");
        const cacheKey = `ai:invoice:${inputHash}`;
        await redis.set(cacheKey, JSON.stringify(injectedGroqOutput), "EX", 300);
    }

    // 4. Trigger extraction
    const fetchRes = await fetch('http://localhost:5000/api/invoice/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: docId })
    });
    
    const data = await fetchRes.json();
    const { jobId, invoiceId } = data;

    // 5. Wait for Job completion
    let job;
    while (true) {
        job = await Job.findById(jobId).lean();
        if (job && (job.status === 'completed' || job.status === 'failed')) break;
        await new Promise(r => setTimeout(r, 400));
    }

    // 6. Retrieve Invoice document
    const inv = await Invoice.findById(invoiceId).lean();
    console.log(`Job Status: ${job.status}`);
    if (inv) {
        console.log(`Invoice Status: ${inv.status}`);
        console.log(`Validation isValid: ${inv.validation.isValid}`);
        console.log(`Missing Fields:`, JSON.stringify(inv.validation.missingFields));
        console.log(`Errors:`, JSON.stringify(inv.validation.errors, null, 2));
        console.log(`Warnings:`, JSON.stringify(inv.validation.warnings, null, 2));
    }

    return { docId, job, inv };
}

async function runAll() {
    await mongoose.connect(process.env.MONGODB_URI);

    const test1Text = "Invoice INV-001 Acme Corp 2024-01-01 Tax: 5 Total: 55 Item: 50";

    // ==========================================
    // TEST 1: Valid invoice
    // ==========================================
    const test1 = await runTest("TEST 1: Valid invoice", test1Text, {
        invoiceNumber: "INV-001", invoiceNumber_evidence: "INV-001",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 5, tax_evidence: "Tax: 5",
        total: 55, total_evidence: "Total: 55",
        lineItems: [{ description: "Item 1", quantity: 2, unitPrice: 25, amount: 50 }]
    });

    // ==========================================
    // TEST 2: Missing required date
    // ==========================================
    await runTest("TEST 2: Missing required date", "Invoice INV-002 Acme Corp Tax: 5 Total: 55", {
        invoiceNumber: "INV-002", invoiceNumber_evidence: "INV-002",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: null, date_evidence: null,
        tax: 5, tax_evidence: "Tax: 5",
        total: 55, total_evidence: "Total: 55",
        lineItems: [{ description: "Item 1", quantity: 2, unitPrice: 25, amount: 50 }]
    });

    // ==========================================
    // TEST 3: Negative total
    // ==========================================
    await runTest("TEST 3: Negative total", "Invoice INV-003 Acme Corp 2024-01-01 Total: -10", {
        invoiceNumber: "INV-003", invoiceNumber_evidence: "INV-003",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 5, tax_evidence: "Tax: 5",
        total: -10, total_evidence: "Total: -10",
        lineItems: []
    });

    // ==========================================
    // TEST 4: Negative tax
    // ==========================================
    await runTest("TEST 4: Negative tax", "Invoice INV-004 Acme Corp 2024-01-01 Tax: -5 Total: 50", {
        invoiceNumber: "INV-004", invoiceNumber_evidence: "INV-004",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: -5, tax_evidence: "Tax: -5",
        total: 50, total_evidence: "Total: 50",
        lineItems: []
    });

    // ==========================================
    // TEST 5: Tax greater than total
    // ==========================================
    await runTest("TEST 5: Tax greater than total", "Invoice INV-005 Acme Corp 2024-01-01 Tax: 15 Total: 10", {
        invoiceNumber: "INV-005", invoiceNumber_evidence: "INV-005",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 15, tax_evidence: "Tax: 15",
        total: 10, total_evidence: "Total: 10",
        lineItems: []
    });

    // ==========================================
    // TEST 6: Valid line item
    // ==========================================
    await runTest("TEST 6: Valid line item", "Invoice INV-006 Acme Corp 2024-01-01 Qty: 2 Price: 10 Amount: 20 Tax: 0 Total: 20", {
        invoiceNumber: "INV-006", invoiceNumber_evidence: "INV-006",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 0, tax_evidence: "Tax: 0",
        total: 20, total_evidence: "Total: 20",
        lineItems: [{ description: "Widget", quantity: 2, unitPrice: 10, amount: 20 }]
    });

    // ==========================================
    // TEST 7: Invalid line item
    // ==========================================
    await runTest("TEST 7: Invalid line item", "Invoice INV-007 Acme Corp 2024-01-01 Qty: 2 Price: 10 Amount: 25 Tax: 0 Total: 25", {
        invoiceNumber: "INV-007", invoiceNumber_evidence: "INV-007",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 0, tax_evidence: "Tax: 0",
        total: 25, total_evidence: "Total: 25",
        lineItems: [{ description: "Widget", quantity: 2, unitPrice: 10, amount: 25 }]
    });

    // ==========================================
    // TEST 8: Incomplete line item
    // ==========================================
    await runTest("TEST 8: Incomplete line item", "Invoice INV-008 Acme Corp 2024-01-01 Qty: 2 Price: 10 Tax: 0 Total: 20", {
        invoiceNumber: "INV-008", invoiceNumber_evidence: "INV-008",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 0, tax_evidence: "Tax: 0",
        total: 20, total_evidence: "Total: 20",
        lineItems: [{ description: "Widget", quantity: 2, unitPrice: 10, amount: null }]
    });

    // ==========================================
    // TEST 9: Valid total
    // ==========================================
    await runTest("TEST 9: Valid total", "Invoice INV-009 Acme Corp 2024-01-01 Items: 20, 30 Tax: 5 Total: 55", {
        invoiceNumber: "INV-009", invoiceNumber_evidence: "INV-009",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 5, tax_evidence: "Tax: 5",
        total: 55, total_evidence: "Total: 55",
        lineItems: [
            { description: "Item 1", quantity: 1, unitPrice: 20, amount: 20 },
            { description: "Item 2", quantity: 1, unitPrice: 30, amount: 30 }
        ]
    });

    // ==========================================
    // TEST 10: Invalid total
    // ==========================================
    await runTest("TEST 10: Invalid total", "Invoice INV-010 Acme Corp 2024-01-01 Items: 20, 30 Tax: 5 Total: 60", {
        invoiceNumber: "INV-010", invoiceNumber_evidence: "INV-010",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: 5, tax_evidence: "Tax: 5",
        total: 60, total_evidence: "Total: 60",
        lineItems: [
            { description: "Item 1", quantity: 1, unitPrice: 20, amount: 20 },
            { description: "Item 2", quantity: 1, unitPrice: 30, amount: 30 }
        ]
    });

    // ==========================================
    // TEST 11: Missing tax
    // ==========================================
    await runTest("TEST 11: Missing tax", "Invoice INV-011 Acme Corp 2024-01-01 Item: 50 Total: 50", {
        invoiceNumber: "INV-011", invoiceNumber_evidence: "INV-011",
        vendor: "Acme Corp", vendor_evidence: "Acme Corp",
        date: "2024-01-01", date_evidence: "2024-01-01",
        tax: null, tax_evidence: null,
        total: 50, total_evidence: "Total: 50",
        lineItems: [{ description: "Item 1", quantity: 1, unitPrice: 50, amount: 50 }]
    });

    // ==========================================
    // TEST 12: Cached extraction
    // ==========================================
    // Uses the exact same text content as TEST 1, so the worker finds the existing Redis cache key
    const test12 = await runTest("TEST 12: Cached extraction", test1Text, null);
    console.log(`Test 12 extraction isValid: ${test12.inv.validation.isValid}`);

    // ==========================================
    // TEST 13: Existing evidence/page tracking
    // ==========================================
    console.log(`\n==================================================\nRunning TEST 13: Existing evidence/page tracking\n==================================================`);
    const inv13 = test1.inv;
    console.log("invoiceNumber:", JSON.stringify(inv13.invoiceNumber));
    console.log("vendor:", JSON.stringify(inv13.vendor));
    console.log("date:", JSON.stringify(inv13.date));
    console.log("tax:", JSON.stringify(inv13.tax));
    console.log("total:", JSON.stringify(inv13.total));

    const evidencePass = 
        inv13.invoiceNumber.value === "INV-001" && inv13.invoiceNumber.page === 1 && inv13.invoiceNumber.evidence !== null &&
        inv13.vendor.value === "Acme Corp" && inv13.vendor.page === 1 && inv13.vendor.evidence !== null &&
        inv13.date.value === "2024-01-01" && inv13.date.page === 1 && inv13.date.evidence !== null &&
        inv13.tax.value === 5 && inv13.tax.page === 1 && inv13.tax.evidence !== null &&
        inv13.total.value === 55 && inv13.total.page === 1 && inv13.total.evidence !== null;

    console.log(`TEST 13 Evidence and Page Tracking intact: ${evidencePass}`);

    await mongoose.disconnect();
    redis.disconnect();
    console.log("\nALL TESTS COMPLETED SUCCESSFULLY.");
}

runAll().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
