function validateInvoiceData(nestedInvoice) {
    const validation = {
        isValid: true,
        missingFields: [],
        errors: [],
        warnings: []
    };

    const reqFields = ["invoiceNumber", "vendor", "date", "total"];
    for (const f of reqFields) {
        if (nestedInvoice[f] === undefined || nestedInvoice[f] === null || nestedInvoice[f].value === null || nestedInvoice[f].value === undefined) {
            validation.missingFields.push(f);
            validation.errors.push({
                field: f,
                code: "MISSING_REQUIRED_FIELD",
                message: `Required invoice field '${f}' is missing.`
            });
        }
    }

    const totalVal = nestedInvoice.total?.value ?? null;
    const taxVal = nestedInvoice.tax?.value ?? null;

    if (totalVal !== null && totalVal < 0) {
        validation.errors.push({
            field: "total",
            code: "NEGATIVE_TOTAL",
            message: "Invoice total cannot be negative."
        });
    }

    if (taxVal !== null && taxVal < 0) {
        validation.errors.push({
            field: "tax",
            code: "NEGATIVE_TAX",
            message: "Invoice tax cannot be negative."
        });
    }

    if (taxVal !== null && totalVal !== null && taxVal > totalVal) {
        validation.errors.push({
            field: "tax",
            code: "TAX_EXCEEDS_TOTAL",
            message: "Invoice tax cannot be greater than the invoice total."
        });
    }

    let allAmountsPresent = true;
    let sumAmounts = 0;
    const hasLineItems = nestedInvoice.lineItems && nestedInvoice.lineItems.length > 0;

    if (hasLineItems) {
        nestedInvoice.lineItems.forEach((li, idx) => {
            const q = li.quantity;
            const u = li.unitPrice;
            const a = li.amount;

            if (q !== null && q !== undefined && u !== null && u !== undefined && a !== null && a !== undefined) {
                const calcAmount = Math.round(q * u * 100);
                const expectedAmount = Math.round(a * 100);
                if (calcAmount !== expectedAmount) {
                    validation.errors.push({
                        field: `lineItems[${idx}]`,
                        code: "LINE_ITEM_AMOUNT_MISMATCH",
                        message: "Line item amount does not equal quantity multiplied by unit price."
                    });
                }
            } else {
                validation.warnings.push({
                    field: `lineItems[${idx}]`,
                    code: "INCOMPLETE_LINE_ITEM",
                    message: "Line item could not be fully validated because quantity, unit price, or amount is missing."
                });
            }

            if (a === null || a === undefined) {
                allAmountsPresent = false;
            } else {
                sumAmounts += Math.round(a * 100);
            }
        });
    }

    if (hasLineItems && totalVal !== null) {
        if (taxVal === null || taxVal === undefined) {
            validation.warnings.push({
                field: "tax",
                code: "TAX_UNAVAILABLE_FOR_CALCULATION",
                message: "Tax was not available, so tax-dependent total validation could not be completed."
            });
        } else if (!allAmountsPresent) {
            validation.warnings.push({
                field: "total",
                code: "TOTAL_CALCULATION_UNAVAILABLE",
                message: "One or more line item amounts are missing, so tax-dependent total validation could not be completed."
            });
        } else {
            const expectedTotal = Math.round(totalVal * 100);
            const calcTotal = sumAmounts + Math.round(taxVal * 100);
            if (calcTotal !== expectedTotal) {
                validation.errors.push({
                    field: "total",
                    code: "TOTAL_MISMATCH",
                    message: "Sum of line items plus tax does not match the extracted invoice total."
                });
            }
        }
    }

    validation.isValid = validation.errors.length === 0;
    
    return validation;
}

module.exports = {
    validateInvoiceData
};
