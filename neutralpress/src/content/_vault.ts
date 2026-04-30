// import { TFile } from "obsidian";
// import { updateFrontMatter } from "../frontmatter";
// import { parseNote } from "./_note.factory";
// import DSG from "../main";

// /**
//  * Gets files by post type and publication tag
//  * @param plugin The DSG plugin instance
//  * @param postType The post type to filter by
//  * @param publicationTag The publication tag to filter by
//  * @param pubContract The publication contract address
//  * @returns An array of stream IDs for matching files
//  */
// export const getFilesByPostType = async (
// 	plugin: DSG,
// 	postType: string,
// 	publicationTag: string,
// 	pubContract: string,
// ): Promise<string[]> => {
// 	const files = plugin.app.vault.getMarkdownFiles();
// 	const streamIds: string[] = [];

// 	for (const file of files) {
// 		try {
// 			const cache = plugin.app.metadataCache.getFileCache(file);
// 			const frontmatter = cache?.frontmatter;

// 			if (frontmatter) {
// 				// Check if post_type matches and publication tag exists in tags
// 				const hasPostType = frontmatter.post_type === postType;
// 				const hasPubTag =
// 					frontmatter.tags &&
// 					Array.isArray(frontmatter.tags) &&
// 					frontmatter.tags.includes(publicationTag);

// 				if (hasPostType && hasPubTag && frontmatter.stream_id) {
// 					streamIds.push(frontmatter.stream_id);
// 				} else if (hasPostType && hasPubTag && !frontmatter.stream_id) {
// 					// If stream_id doesn't exist but file matches criteria, generate it
// 					const streamId = await generateStreamId(
// 						plugin,
// 						file,
// 						pubContract,
// 					);
// 					if (streamId) {
// 						streamIds.push(streamId);
// 					}
// 				}
// 			}
// 		} catch (error) {
// 			console.error(`Error processing file ${file.path}:`, error);
// 		}
// 	}

// 	return streamIds;
// };

// /**
//  * Generates a stream ID for a file that doesn't have one
//  * @param plugin The DSG plugin instance
//  * @param file The file to generate a stream ID for
//  * @param pubContract The publication contract address
//  * @returns The generated stream ID or null if it could not be generated
//  */
// const generateStreamId = async (
// 	plugin: DSG,
// 	file: TFile,
// 	pubContract: string,
// ): Promise<string | null> => {
// 	try {
// 		const mainController = plugin.ctrlr;

// 		// Check if the file exists
// 		if (!file) {
// 			return null;
// 		}

// 		// Parse the note to get required data
// 		const parsedNote = await parseNote(mainController, file);
// 		const { queryable } = parsedNote;

// 		// Create a mock item with minimal required data
// 		const mock = {
// 			...queryable,
// 			encrypted: "{}",
// 		};

// 		// Insert the mock item to get a stream ID
// 		const res = await mainController.oxo.ctrlr.orbis.insert(
// 			mock,
// 			mainController.protocolInfo.config.db_model,
// 			mainController.protocolInfo.config.db_context,
// 		);

// 		// Update the frontmatter with the new stream ID
// 		if (res.id) {
// 			await updateFrontMatter(plugin.app, file, "stream_id", res.id);
// 			return res.id;
// 		}

// 		return null;
// 	} catch (error) {
// 		console.error(`Error generating stream ID for ${file.path}:`, error);
// 		return null;
// 	}
// };

// /**
//  * Gets files based on other criteria (e.g., folder, tags, etc.)
//  * @param plugin The DSG plugin instance
//  * @param criteria The criteria to filter by
//  * @returns An array of matching files
//  */
// export const getFilesByCriteria = (
// 	plugin: DSG,
// 	criteria: {
// 		folder?: string;
// 		tags?: string[];
// 		postType?: string;
// 	},
// ): TFile[] => {
// 	const files = plugin.app.vault.getMarkdownFiles();

// 	return files.filter((file) => {
// 		const cache = plugin.app.metadataCache.getFileCache(file);
// 		const frontmatter = cache?.frontmatter;

// 		if (!frontmatter) return false;

// 		// Check folder
// 		if (criteria.folder && !file.path.startsWith(criteria.folder)) {
// 			return false;
// 		}

// 		// Check post type
// 		if (criteria.postType && frontmatter.post_type !== criteria.postType) {
// 			return false;
// 		}

// 		// Check tags
// 		if (criteria.tags && criteria.tags.length > 0) {
// 			if (!frontmatter.tags || !Array.isArray(frontmatter.tags)) {
// 				return false;
// 			}

// 			for (const tag of criteria.tags) {
// 				if (!frontmatter.tags.includes(tag)) {
// 					return false;
// 				}
// 			}
// 		}

// 		return true;
// 	});
// };
