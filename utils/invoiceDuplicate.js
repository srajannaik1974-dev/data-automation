/**
 * Generates a normalized identity key for an invoice based on vendor and invoice number.
 * 
 * @param {string} vendor 
 * @param {string} invoiceNumber 
 * @returns {string|null} Normalized key or null if either field is missing.
 */
function getNormalizedIdentityKey(vendor, invoiceNumber) {
    if (vendor === null || vendor === undefined || vendor === "") return null;
    if (invoiceNumber === null || invoiceNumber === undefined || invoiceNumber === "") return null;

    const vStr = String(vendor);
    const iStr = String(invoiceNumber);

    const normVendor = vStr.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normInvoice = iStr.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (!normVendor || !normInvoice) return null;

    return `${normVendor}|${normInvoice}`;
}

module.exports = {
    getNormalizedIdentityKey
};
