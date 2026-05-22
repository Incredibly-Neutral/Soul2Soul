import { IPFS_URL } from "./constants";
import {
  cleanTemplateString,
  processPartials,
  processTemplate,
} from "./handlebars.factory";

export const renderHTML = async (
  config: any,
  templateConfig: any,
  templateData: any,
) => {
  try {
    // Validate inputs
    if (!config?.templateCid || !templateConfig?.file) {
      console.error("Missing required config:", {
        templateCid: config?.templateCid,
        file: templateConfig?.file,
      });
      return "";
    }

    // Fetch template array
    const response = await fetch(
      `${IPFS_URL}/api/v0/dag/get?arg=${config.templateCid}`,
      {
        method: "POST",
      },
    );

    if (!response.ok) {
      console.error(
        "Template fetch failed:",
        response.status,
        response.statusText,
      );
      return "";
    }

    const templateArray = await response.json();
    const templateFile = templateArray.find(
      (t: any) =>
        t.path.endsWith(`/${templateConfig.file}.handlebars`) ||
        t.path.endsWith(`/${templateConfig.file}`),
    );

    if (!templateFile?.cid) {
      console.error("Template file not found:", templateConfig.file);
      return "";
    }

    // Fetch template content
    const templateResponse = await fetch(
      `${IPFS_URL}/api/v0/cat?arg=${templateFile.cid}`,
      {
        method: "POST",
      },
    );

    if (!templateResponse.ok) {
      console.error(
        "Template content fetch failed:",
        templateResponse.status,
        templateResponse.statusText,
      );
      return "";
    }

    // Clean and process template
    const template = cleanTemplateString(await templateResponse.text())
      .replace(/^"/, "") // Remove leading quote if present
      .replace(/"$/, "") // Remove trailing quote if present
      .replace(/(?<=>)"/g, "") // Remove quotes after >
      .replace(/"(?=<)/g, ""); // Remove quotes before <

    if (!template) {
      console.error("Empty template after cleaning");
      return "";
    }

    // console.log(templateData);

    // Find and process partials
    const partialFiles = templateArray.filter(
      (t: any) =>
        t.path.includes("partials/") && t.path.endsWith(".handlebars"),
    );
    const result = await processPartials(template, partialFiles, templateData);

    if (!result) {
      console.error("Empty result after processing");
      return "";
    }

    // Clean up whitespace and remove any characters preceding DOCTYPE
    let cleanedResult = result
      .replace(/\n{2,}/g, "\n")
      .replace(/>\s+</g, ">\n<")
      .trim();

    // Remove any characters before <!DOCTYPE - this includes asterisks and other unexpected characters
    const doctypePattern = /<!DOCTYPE/i;
    const doctypeMatch = doctypePattern.exec(cleanedResult);

    if (doctypeMatch && doctypeMatch.index > 0) {
      // Remove everything before the DOCTYPE declaration
      cleanedResult = cleanedResult.substring(doctypeMatch.index);
    }

    return cleanedResult;
  } catch (error) {
    console.error("Error in renderer:", error);
    return "";
  }
};
