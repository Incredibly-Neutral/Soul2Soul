import { App } from "electron";
import { TFile } from "obsidian";
import { IMainController } from "src/main.ctrlr";
import TurndownService from "turndown";

export const distributeImages = async (
	main: IMainController,
	app: any,
	note: TFile,
	content: string,
	gateway: string,
) => {
	const imgRegex = /<img[^>]+>/g;
	let modifiedContent = content;

	// First find all image tags
	const imgTags = content.match(imgRegex);
	if (imgTags) {
		for (const imgTag of imgTags) {
			// Extract src attribute
			const srcRegex = /src="([^"]+)"/;
			const srcMatch = imgTag.match(srcRegex);
			if (!srcMatch || !srcMatch[1].startsWith("file://")) continue;

			const originalSrc = srcMatch[1].replace("file://", "");
			const response = await main.oxo.ctrlr.pinata.uploadFileFromPath(
				originalSrc,
				false,
			);
			const newSrc = `${gateway}/ipfs/${response}`;

			// Extract alt text if present in markdown syntax
			const markdownImgRegex = /!\[(.*?)\]\((.*?)\)/;
			const markdownMatch = content.match(markdownImgRegex);
			const altText = markdownMatch ? markdownMatch[1] : "";

			// Replace both the wrapped <p> tags and the image with markdown syntax
			const wrappedImgRegex = new RegExp(`<p>${imgTag}</p>`, "g");
			modifiedContent = modifiedContent.replace(
				wrappedImgRegex,
				`<img src="${newSrc}" alt="${altText}">`,
			);
			// Also handle case where image isn't wrapped in p tags
			modifiedContent = modifiedContent.replace(
				imgTag,
				`<img src="${newSrc}" alt="${altText}">`,
			);
		}

		// Read the original file to get both content and frontmatter
		const originalContent = await main.plugin.app.vault.read(note);
		const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
		const frontmatterMatch = originalContent.match(frontmatterRegex);

		const turndownService = new TurndownService();
		const markDownContent = turndownService.turndown(modifiedContent);

		if (frontmatterMatch) {
			await main.plugin.app.vault.modify(
				note,
				`${frontmatterMatch[0]}${markDownContent}`,
			);
		} else {
			await main.plugin.app.vault.modify(note, markDownContent);
		}
	}

	return modifiedContent;
};