const fs = require("fs");
const { PDFParse } = require("pdf-parse");

async function extractPDF() {
    const filePath = "uploads/23369161be5d5b7377cd60cb03dadf18";

    const pdfBuffer = fs.readFileSync(filePath);

    const parser = new PDFParse({
        data: pdfBuffer
    });

    const result = await parser.getText();

    console.log("Total pages:", result.total);

    result.pages.forEach((page, index) => {
        console.log(`\n===== PAGE ${index + 1} =====`);
        console.log(page.text);
    });

    await parser.destroy();
}

extractPDF();