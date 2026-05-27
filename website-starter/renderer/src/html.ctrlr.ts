import { catFile, getDag } from "../../../protocol/actions/src/libs/ipfs.factory";
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

    // console.log("renderer", templateData);

    let templateArray = await getDag(config.template_cid);

    const templateFile = templateArray.find((t: any) =>
      t.path.includes(templateConfig.file),
    );

    if (!templateFile?.cid) {
      console.error("Template file not found:", templateConfig.file);
      return "";
    }

    const templateString = await catFile(templateFile.cid)

    const template = cleanTemplateString(templateString)
      .replace(/^"/, "") // Remove leading quote if present
      .replace(/"$/, "") // Remove trailing quote if present
      .replace(/(?<=>)"/g, "") // Remove quotes after >
      .replace(/"(?=<)/g, ""); // Remove quotes before <

    if (!template) {
      console.error("Empty template after cleaning");
      return "";
    }

    const partialFiles = templateArray.filter((t: any) =>
      t.path.includes("partials/"),
    );

    const result = await processPartials(template, partialFiles, templateData);

    if (!result) {
      console.error("Empty result after processing");
      return "";
    }

    // Clean up whitespace in final result
    return result
      .replace(/\n{2,}/g, "\n")
      .replace(/>\s+</g, ">\n<")
      .trim();
  } catch (error) {
    console.error("Error in renderer:", error);
    return "";
  }
};
