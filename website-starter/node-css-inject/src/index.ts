const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { PinataService } = require("./pinata.service");

// Load environment variables from .env file
dotenv.config();

const pinataJwt = process.env.PINATA_JWT || "";
const assetsGateway = process.env.ASSETS_GATEWAY || "";

async function injectCSS() {
  try {
    const pinataService = new PinataService(pinataJwt, assetsGateway);
    const cssPath = path.join(__dirname, "../../css/styles.css");
    const newCid = await pinataService.uploadFileFromPath(cssPath);

    // Read the template file
    const templatePath = path.join(
      __dirname,
      "../../templates/partials/head.handlebars",
    );
    const templateContent = await fs.readFile(templatePath, "utf-8");

    // Find and replace the stylesheet link
    const styleRegex =
      /<link[^>]*id="main"[^>]*rel="stylesheet"[^>]*>|<link[^>]*rel="stylesheet"[^>]*id="main"[^>]*>/;
    const newStyleLink = `<link id="main" rel="stylesheet" href="${assetsGateway}/ipfs/${newCid}?filename=styles.css">`;

    console.log("newStyleLink", newStyleLink);

    // Create the modified content
    const updatedContent = templateContent.replace(styleRegex, newStyleLink);

    // Write the modified content back to the file
    await fs.writeFile(templatePath, updatedContent);

    console.log("CSS injection completed successfully");
    return newCid;
  } catch (error) {
    console.error("Error during CSS injection:", error);
    throw error;
  }
}

injectCSS();
