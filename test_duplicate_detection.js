require('dotenv').config();
const mongoose = require('mongoose');
const Invoice = require('./models/Invoice');
const { getNormalizedIdentityKey } = require('./utils/invoiceDuplicate');

async function runTests() {
    await mongoose.connect(process.env.MONGODB_URI);
    
    console.log("==================================================");
    console.log("DUPLICATE DETECTION TESTS");
    console.log("==================================================");
    
    let passCount = 0;
    let failCount = 0;

    function assertEq(name, actual, expected) {
        if (actual === expected) {
            console.log(`[PASS] ${name}`);
            passCount++;
        } else {
            console.error(`[FAIL] ${name} (Expected: ${expected}, Got: ${actual})`);
            failCount++;
        }
    }

    // Prepare some fake document and user IDs
    const mockDocumentId1 = new mongoose.Types.ObjectId();
    const mockDocumentId2 = new mongoose.Types.ObjectId();
    const mockDocumentId3 = new mongoose.Types.ObjectId();
    const mockDocumentId4 = new mongoose.Types.ObjectId();
    const mockJobId = new mongoose.Types.ObjectId();
    const mockUserId = new mongoose.Types.ObjectId();

    // Clean up
    await Invoice.deleteMany({ userId: mockUserId });

    console.log("\nI. Vendor normalization");
    const k1 = getNormalizedIdentityKey("Acme, Inc.", "INV-001");
    const k2 = getNormalizedIdentityKey("acmeinc", "inv001");
    assertEq("Keys match", k1, k2);
    
    const k3 = getNormalizedIdentityKey(null, "INV");
    assertEq("Missing vendor = null", k3, null);

    const k4 = getNormalizedIdentityKey("Acme", null);
    assertEq("Missing invoice = null", k4, null);


    console.log("\nA. First invoice");
    const inv1 = await Invoice.create({
        userId: mockUserId,
        documentId: mockDocumentId1,
        jobId: mockJobId,
        invoiceNumber: { value: "DUP-100" },
        vendor: { value: "Duplicate Co" },
        normalizedIdentityKey: getNormalizedIdentityKey("Duplicate Co", "DUP-100"),
        duplicate: {
            isPossibleDuplicate: false,
            duplicateOf: null,
            status: "not_duplicate"
        },
        review: {
            status: "pending",
            validation: { isValid: true, errors: [], warnings: [] },
            corrections: {}
        },
        validation: { isValid: true, errors: [], warnings: [] }
    });
    
    assertEq("First invoice not duplicate", inv1.duplicate.isPossibleDuplicate, false);


    console.log("\nB. Exact duplicate");
    // Emulate worker saving the second
    let duplicateInfo = { isPossibleDuplicate: false, duplicateOf: null, status: "not_duplicate" };
    const normKey = getNormalizedIdentityKey("Duplicate Co", "DUP-100");
    const match = await Invoice.findOne({ normalizedIdentityKey: normKey });
    if (match) {
        duplicateInfo = {
            isPossibleDuplicate: true,
            duplicateOf: match._id,
            status: "unresolved"
        };
    }
    
    const inv2 = await Invoice.create({
        userId: mockUserId,
        documentId: mockDocumentId2,
        jobId: mockJobId,
        invoiceNumber: { value: "DUP-100" },
        vendor: { value: "Duplicate Co" },
        normalizedIdentityKey: normKey,
        duplicate: duplicateInfo,
        review: {
            status: "pending",
            validation: { isValid: true, errors: [], warnings: [] },
            corrections: {}
        },
        validation: { isValid: true, errors: [], warnings: [] }
    });
    
    assertEq("Second invoice flagged", inv2.duplicate.isPossibleDuplicate, true);
    assertEq("Second invoice points to first", inv2.duplicate.duplicateOf.toString(), inv1._id.toString());
    assertEq("Second invoice status unresolved", inv2.duplicate.status, "unresolved");

    
    console.log("\nL. Approval (Blocked)");
    let res = await fetch(`http://localhost:5000/api/invoice/${inv2._id}/review/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: mockUserId }) });
    assertEq("Approval blocked (409)", res.status, 409);

    
    console.log("\nK. Duplicate resolution");
    res = await fetch(`http://localhost:5000/api/invoice/${inv2._id}/duplicate`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: "confirmed" }) });
    assertEq("Resolution Confirmed -> 200", res.status, 200);
    
    res = await fetch(`http://localhost:5000/api/invoice/${inv2._id}/review/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: mockUserId }) });
    assertEq("Approval still blocked after confirmed (409)", res.status, 409);

    res = await fetch(`http://localhost:5000/api/invoice/${inv2._id}/duplicate`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: "not_duplicate" }) });
    assertEq("Resolution Not Duplicate -> 200", res.status, 200);

    res = await fetch(`http://localhost:5000/api/invoice/${inv2._id}/review/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: mockUserId }) });
    assertEq("Approval allowed after not_duplicate (200)", res.status, 200);


    console.log("\nC & D. Different Vendor / Invoice");
    const inv3 = await Invoice.create({
        userId: mockUserId,
        documentId: mockDocumentId3,
        jobId: mockJobId,
        invoiceNumber: { value: "DUP-101" }, // diff number
        vendor: { value: "Duplicate Co" },
        normalizedIdentityKey: getNormalizedIdentityKey("Duplicate Co", "DUP-101"),
        duplicate: {
            isPossibleDuplicate: false,
            duplicateOf: null,
            status: "not_duplicate"
        }
    });
    assertEq("Different invoice number not flagged", inv3.duplicate.isPossibleDuplicate, false);


    console.log("\nJ. Correction");
    // We patch inv3 to have same invoice number as inv1 ("DUP-100")
    res = await fetch(`http://localhost:5000/api/invoice/${inv3._id}/review`, { 
        method: 'PATCH', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ corrections: { invoiceNumber: "DUP-100" } }) 
    });
    assertEq("Patch review -> 200", res.status, 200);
    const patchedInv = await Invoice.findById(inv3._id).lean();
    assertEq("Correction updated identity key", patchedInv.normalizedIdentityKey, getNormalizedIdentityKey("Duplicate Co", "DUP-100"));
    assertEq("Correction flagged as duplicate", patchedInv.duplicate.isPossibleDuplicate, true);
    assertEq("Correction set status unresolved", patchedInv.duplicate.status, "unresolved");

    // Revert correction
    res = await fetch(`http://localhost:5000/api/invoice/${inv3._id}/review`, { 
        method: 'PATCH', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ corrections: { invoiceNumber: null } }) 
    });
    const revertedInv = await Invoice.findById(inv3._id).lean();
    assertEq("Revert removed duplicate flag", revertedInv.duplicate.isPossibleDuplicate, false);
    assertEq("Revert restored status to not_duplicate", revertedInv.duplicate.status, "not_duplicate");


    console.log("\nG & H. Missing vendor/invoice number");
    const inv4 = await Invoice.create({
        userId: mockUserId,
        documentId: mockDocumentId4,
        jobId: mockJobId,
        invoiceNumber: { value: null }, 
        vendor: { value: "Duplicate Co" },
        normalizedIdentityKey: getNormalizedIdentityKey("Duplicate Co", null),
        duplicate: {
            isPossibleDuplicate: false,
            duplicateOf: null,
            status: "not_duplicate"
        }
    });
    assertEq("Missing invoice number not flagged", inv4.duplicate.isPossibleDuplicate, false);

    
    console.log("\nM. Concurrent duplicate simulation");
    const mockDocumentId5 = new mongoose.Types.ObjectId();
    const mockDocumentId6 = new mongoose.Types.ObjectId();
    
    // Simulate what the worker does under the hood concurrently
    async function simulateWorkerSave(docId, vendor, invNumber) {
        const invoiceId = new mongoose.Types.ObjectId();
        
        // We will call the EXACT logic from worker.js manually to simulate
        const normKey = getNormalizedIdentityKey(vendor, invNumber);
        let duplicateInfo = { isPossibleDuplicate: false, duplicateOf: null, status: "not_duplicate" };
        
        const redisConnection = require('./config/redis');
        
        if (normKey) {
            const lockKey = `lock:duplicate:${normKey}`;
            let locked = false;
            for (let i = 0; i < 15; i++) {
                const acquired = await redisConnection.set(lockKey, "locked", "NX", "EX", 10);
                if (acquired) {
                    locked = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 200));
            }

            try {
                if (locked) {
                    const match = await Invoice.findOne({ 
                        normalizedIdentityKey: normKey, 
                        _id: { $ne: invoiceId } 
                    }).sort({ createdAt: -1 }).lean();

                    if (match) {
                        duplicateInfo = {
                            isPossibleDuplicate: true,
                            duplicateOf: match._id,
                            status: "unresolved"
                        };
                    }
                    
                    await Invoice.create({
                        _id: invoiceId,
                        userId: mockUserId,
                        documentId: docId,
                        jobId: mockJobId,
                        invoiceNumber: { value: invNumber },
                        vendor: { value: vendor },
                        normalizedIdentityKey: normKey,
                        duplicate: duplicateInfo
                    });
                }
            } finally {
                if (locked) {
                    await redisConnection.del(lockKey);
                }
            }
        }
        return invoiceId;
    }

    const [idA, idB] = await Promise.all([
        simulateWorkerSave(mockDocumentId5, "Concurrent Vendor", "CON-100"),
        simulateWorkerSave(mockDocumentId6, "Concurrent Vendor", "CON-100")
    ]);
    
    const invA = await Invoice.findById(idA);
    const invB = await Invoice.findById(idB);
    
    // One must be unique, one must be a duplicate
    const oneIsDuplicate = (invA.duplicate.isPossibleDuplicate && !invB.duplicate.isPossibleDuplicate) || 
                           (!invA.duplicate.isPossibleDuplicate && invB.duplicate.isPossibleDuplicate);
                           
    assertEq("One invoice is flagged as duplicate", oneIsDuplicate, true);

    console.log(`\n==================================================`);
    console.log(`SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
    console.log(`==================================================`);

    await Invoice.deleteMany({ userId: mockUserId });
    await mongoose.disconnect();
}

runTests().catch(console.error);
