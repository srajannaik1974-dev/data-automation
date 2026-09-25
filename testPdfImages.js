const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

async function test() {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const pdfPath = "uploads\\ee0f5c3d68003a2637a2ada85bd2ad0d";

    const data = new Uint8Array(
        fs.readFileSync(pdfPath)
    );

    const pdf = await pdfjsLib.getDocument({
        data
    }).promise;

    console.log("Total pages:", pdf.numPages);

    const outputDir = "uploads/pdf-images";

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {

        const page = await pdf.getPage(pageNumber);

        const operatorList = await page.getOperatorList();

        let imageIndex = 0;

        for (let i = 0; i < operatorList.fnArray.length; i++) {

            const fn = operatorList.fnArray[i];
            const args = operatorList.argsArray[i];

            if (
                fn === pdfjsLib.OPS.paintImageXObject ||
                fn === pdfjsLib.OPS.paintJpegXObject
            ) {

                const imageName = args[0];

                const image = await new Promise((resolve) => {
                    page.objs.get(imageName, resolve);
                });

                if (!image || !image.data) {
                    console.log(
                        `Could not extract image on page ${pageNumber}`
                    );
                    continue;
                }

                imageIndex++;

                const png = new PNG({
                    width: image.width,
                    height: image.height
                });

                png.data = Buffer.from(image.data);

                const outputPath = path.join(
                    outputDir,
                    `page-${pageNumber}-image-${imageIndex}.png`
                );

                png.pack().pipe(
                    fs.createWriteStream(outputPath)
                );

                console.log(
                    `Saved: ${outputPath}`
                );
            }
        }
    }
}

test().catch(error => {
    console.error("Image extraction failed:", error);
});