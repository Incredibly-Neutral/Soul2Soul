// import { App, FileManager, TFile } from "obsidian";
// import { IMainController } from "../main.ctrlr";




// export const followLink = async (
// 	key: string,
// 	linkText: string,
// 	app: App,
// ): Promise<string> => {
// 	return new Promise(async (resolve, reject) => {
// 		let files = app.vault.getMarkdownFiles();
// 		let file = files.find(
// 			(f) =>
// 				f.basename ==
// 				linkText
// 					.replace("[", "")
// 					.replace("[", "")
// 					.replace("]", "")
// 					.replace("]", ""),
// 		);
// 		if (file != undefined) {
// 			await app.fileManager.processFrontMatter(file, (frontmatter) => {
// 				resolve(frontmatter[key]);
// 			});
// 		} else {
// 			throw Error(`link to ${key} not specified or found`);
// 		}
// 	});
// };

// export const saveRoot = async (
// 	main: IMainController,
// 	cid: string,
// 	file: TFile,
// ): Promise<void> => {
// 	// find file for publication

// 	let publication = "";

// 	await main.plugin.app.fileManager.processFrontMatter(
// 		file,
// 		(frontmatter) => {
// 			publication = frontmatter["publication"]
// 				.replace("[", "")
// 				.replace("[", "")
// 				.replace("]", "")
// 				.replace("]", "");
// 		},
// 	);

// 	let pubfile = main.plugin.app.vault
// 		.getMarkdownFiles()
// 		.find((f) => f.basename == publication);
// 	if (pubfile != undefined) {
// 		await main.plugin.app.fileManager.processFrontMatter(
// 			pubfile,
// 			(frontmatter) => {
// 				// do some check first -- QmYeo7FUc9B5GmJQaqUHnqyJpi6BmwxsfYyNYFJ8J9ndVY
// 				// frontmatter["archive"] = cid;
// 			},
// 		);
// 	} else {
// 		throw Error("failed to include archive in publication");
// 	}
// };

// export const saveRootDirectly = async (
// 	cid: string,
// 	url: string,
// 	pubName: string,
// 	app: App,
// ): Promise<[string, string]> => {
// 	const pubfile = app.vault
// 		.getFiles()
// 		.find((f) => f.basename == pubName + ".publication");

// 	if (pubfile != undefined) {
// 		await app.fileManager.processFrontMatter(pubfile, (frontmatter) => {
// 			frontmatter["archive"] = cid;
// 		});
// 	} else {
// 		throw Error("failed to include archive in publication");
// 	}

// 	return [cid, url];
// };

// export const includeUrl = async (
// 	main: IMainController,
// 	url: string,
// 	file: TFile,
// ): Promise<void> => {
// 	await main.plugin.app.fileManager.processFrontMatter(
// 		file,
// 		(frontmatter) => {
// 			frontmatter["url"] = url;
// 		},
// 	);
// };
