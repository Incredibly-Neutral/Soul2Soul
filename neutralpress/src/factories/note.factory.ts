import { App, TFile } from "obsidian";

import slugify from "slugify";
import { IMainController } from "../main.ctrlr";
import { marked } from "marked";
import TurndownService from "turndown";

export const slug = (title: string): string => {
	const options = {
		lower: true, // Convert to lowercase
		remove: /['"?!.,:;()\[\]{}@#$%^&*+=<>~`|\\]/g, // Remove special characters that are unsafe for URLs
		strict: true, // Replace spaces with dashes
	};

	return slugify(title, options);
};

export const parseNote = async (
	main: IMainController,
	file: TFile,
): Promise<any> => {
	const rawFile = await main.plugin.app.vault.read(file);

	let { streamId, queryable, toEncrypt } = await parseFrontmatter(
		main,
		file,
		main.plugin.app,
	);

	const cache = main.plugin.app.metadataCache.getFileCache(file);
	const frontmatter = cache?.frontmatter;
	// const publicationAddress = await main.publication.getPublicationMultiSigAdresses(
	// 	frontmatter?.tags,
	// );

	if (file.name != undefined)
		toEncrypt.title = file.name.replace(/\.[^/.]+$/, "");
	let [content, title, baseFileName] = extractTitleAndBase(rawFile, toEncrypt.title);
	toEncrypt.slug = slug(title || toEncrypt.title);

	// if (baseFileName != undefined) {
	// 	const baseFile = main.plugin.app.vault
	// 		.getFiles()
	// 		.find(
	// 			(file) =>
	// 				file.basename === baseFileName ||
	// 				file.name === baseFileName,
	// 		);


	// 	if (baseFile) {
	// 		toEncrypt.bases = await parseBase(
	// 			main,
	// 			baseFile,
	// 			publicationAddress,
	// 		);
	// 	}
	// }

	toEncrypt.content = await marked(content);
	toEncrypt.content = await distributeImages(
		main,
		main.plugin.app,
		file,
		toEncrypt.content,
		main.protocolInfo.gateway,
	);

	if (title != undefined && title != "") toEncrypt.title = title;

	return { streamId, queryable, toEncrypt };
};

export const distributeImages = async (
	main: IMainController,
	app: App,
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

const removeCodeBlocks = (text: string) => {
	return text.replace(/```[\s\S]*?```/g, "");
};

const removeMarkdownImages = (text: string) => {
	return text.replace(/!\[.*?\]\(.*?\)/g, "");
};

const extractTitleAndBase = (
	raw: string,
	title: string,
): [string, string | undefined, string | undefined] => {
	let baseFileName: string | undefined = undefined;
	let content = raw.split("---")[2].trim();

	// Check if content contains any .base references
	const baseRegex = /!\[\[(.*?)\.base(\.md)?\]\]/g;
	const baseMatches = content.match(baseRegex);

	if (baseMatches) {
		baseFileName = baseMatches[0].replace(/!\[\[(.*?)\]\]/g, "$1");
		// Remove the base reference from the content
		content = content.replace(baseRegex, "");
	}

	// content = removeMarkdownImages(content);
	// content = removeCodeBlocks(content);

	content = content.replace(/^\n+/, "");

	if (content.slice(0, 2) == "# ") {
		const parts = content.split("\n");
		title = parts[0].replace("# ", "").trim();
		parts.shift();
		content = parts.join("\n").trim();
	} else {
		title = title.split(".")[0].trim();
	}

	return [content, title, baseFileName];
};

const skipDefault = (fmcopy: Record<string, any>): Record<string, any> => {
	const keysToDelete = [
		"args",
		"categories",
		"cid",
		"contract",
		"creation_date",
		"language",
		"modified_date",
		"position",
		"parent",
		"post_type",
		"publication",
		"sgId",
		"stream_id",
		"tags",
		"url",
	];

	keysToDelete.forEach((key) => {
		if (key in fmcopy) {
			delete fmcopy[key];
		}
	});

	Object.entries(fmcopy).forEach(([k, v]: [string, any]) => {
		if (v == null && k in fmcopy) {
			delete fmcopy[k];
		}
	});

	return fmcopy;
};

const parseFrontmatter = async (
	main: IMainController,
	file: TFile,
	app: App,
): Promise<{ streamId: string; queryable: any; toEncrypt: any }> => {
	return new Promise(async (resolve: any, reject: any) => {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;

		if (frontmatter != null) {
			const streamId =
				frontmatter.stream_id != undefined
					? frontmatter.stream_id
					: null;

			// possibly check if content was modified ???
			const now = new Date().toJSON().split(".")[0];
			frontmatter.modified_date = now;
			main.content.updateFrontMatter(app, file, "modified_date", now)


			if (frontmatter.creation_date == undefined) {
				frontmatter.creation_date = now;
				main.content.updateFrontMatter(app, file, "creation_date", now)
			}

			if (frontmatter.position == undefined) {
				frontmatter.position = "0";
				main.content.updateFrontMatter(app, file, "position", frontmatter.position)
			}

			let tags = frontmatter.tags
				? JSON.parse(JSON.stringify(frontmatter.tags))
				: [];

			const nonWebTags = tags.filter(
				(tag: string) => !tag.endsWith("--s2s"),
			);
			const publications = tags
				.filter((tag: string) => tag.endsWith("--s2s"))
				.map((tag: string) => tag.replace("--s2s", ".soul2soul.eth"));

			const queryable = {
				creation_date: Math.floor(
					new Date(frontmatter.creation_date).getTime() / 1000,
				),
				modified_date: Math.floor(
					new Date(frontmatter.modified_date).getTime() / 1000,
				),
				language:
					frontmatter.language != undefined
						? frontmatter.language
						: "nl",
				parent:
					frontmatter.parent != undefined
						? parseInt(frontmatter.parent)
						: 0,
				position:
					frontmatter.position != undefined
						? parseInt(frontmatter.position)
						: 0,
				post_type: frontmatter.post_type,
				publications,
				tags,
			};

			console.log(queryable)

			const toEncrypt = {
				content: "",
				title: "",
				custom: JSON.stringify(
					skipDefault(JSON.parse(JSON.stringify(frontmatter))),
				),
				slug: "",
			};

			resolve({ streamId, queryable, toEncrypt });
		}
	});
};

export const followLink = async (
	key: string,
	linkText: string,
	app: App,
): Promise<string> => {
	return new Promise(async (resolve, reject) => {
		let files = app.vault.getMarkdownFiles();
		let file = files.find(
			(f) =>
				f.basename ==
				linkText
					.replace("[", "")
					.replace("[", "")
					.replace("]", "")
					.replace("]", ""),
		);
		if (file != undefined) {
			await app.fileManager.processFrontMatter(file, (frontmatter) => {
				resolve(frontmatter[key]);
			});
		} else {
			throw Error(`link to ${key} not specified or found`);
		}
	});
};

export const saveRoot = async (
	main: IMainController,
	cid: string,
	file: TFile,
): Promise<void> => {
	// find file for publication

	let publication = "";

	await main.plugin.app.fileManager.processFrontMatter(
		file,
		(frontmatter) => {
			publication = frontmatter["publication"]
				.replace("[", "")
				.replace("[", "")
				.replace("]", "")
				.replace("]", "");
		},
	);

	let pubfile = main.plugin.app.vault
		.getMarkdownFiles()
		.find((f) => f.basename == publication);
	if (pubfile != undefined) {
		await main.plugin.app.fileManager.processFrontMatter(
			pubfile,
			(frontmatter) => {
				// do some check first -- QmYeo7FUc9B5GmJQaqUHnqyJpi6BmwxsfYyNYFJ8J9ndVY
				// frontmatter["archive"] = cid;
			},
		);
	} else {
		throw Error("failed to include archive in publication");
	}
};

export const saveRootDirectly = async (
	cid: string,
	url: string,
	pubName: string,
	app: App,
): Promise<[string, string]> => {
	const pubfile = app.vault
		.getFiles()
		.find((f) => f.basename == pubName + ".publication");

	if (pubfile != undefined) {
		await app.fileManager.processFrontMatter(pubfile, (frontmatter) => {
			frontmatter["archive"] = cid;
		});
	} else {
		throw Error("failed to include archive in publication");
	}

	return [cid, url];
};

export const includeUrl = async (
	main: IMainController,
	url: string,
	file: TFile,
): Promise<void> => {
	await main.plugin.app.fileManager.processFrontMatter(
		file,
		(frontmatter) => {
			frontmatter["url"] = url;
		},
	);
};
