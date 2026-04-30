// import YAML from "yaml";
// import { IMainController } from "../main.ctrlr";
// import { App, FileManager, TFile } from "obsidian";
// import slugify from "slugify";
// import { marked } from "marked";

// const _parseYaml = (rawFile: string) => {
// 	// Extract the YAML structure from the content
// 	// console.log(rawFile);

// 	// Try direct YAML parsing first
// 	try {
// 		// Simple check if there's a 'views' key in the string
// 		if (rawFile.includes("views:")) {
// 			// Extract the views section with all its indented content
// 			// This approach is based on indentation levels to capture the complete structure
// 			const lines = rawFile.split("\n");
// 			const viewsLineIndex = lines.findIndex((line) =>
// 				line.trim().startsWith("views:"),
// 			);

// 			if (viewsLineIndex >= 0) {
// 				// Get the indentation level of the views line
// 				const indentMatch = lines[viewsLineIndex].match(/^\s*/);
// 				const viewsIndentation = indentMatch
// 					? indentMatch[0].length
// 					: 0;

// 				// Start collecting lines, beginning with the views line
// 				const relevantLines = [lines[viewsLineIndex]];

// 				// Continue collecting lines that have greater indentation than the views line
// 				// or empty lines that are part of the YAML structure
// 				for (let i = viewsLineIndex + 1; i < lines.length; i++) {
// 					const line = lines[i];
// 					// Stop if we hit a line with same or less indentation (unless it's an empty line)
// 					const lineIndentMatch = line.match(/^\s*/);
// 					if (
// 						line.trim() !== "" &&
// 						(lineIndentMatch ? lineIndentMatch[0].length : 0) <=
// 							viewsIndentation
// 					) {
// 						break;
// 					}
// 					relevantLines.push(line);
// 				}

// 				const viewsContent = relevantLines.join("\n");
// 				const parsedYaml = YAML.parse(viewsContent);
// 				if (parsedYaml && parsedYaml.views) {
// 					return parsedYaml.views;
// 				}
// 			}
// 		}
// 	} catch (error) {
// 		console.error("Error parsing YAML directly:", error);
// 	}

// 	return { views: [] };
// };

// export const extractQuotedStrings = (text: string): string => {
// 	const regex = /"([^"]*)"/g;
// 	const matches: string[] = [];
// 	let match;

// 	while ((match = regex.exec(text)) !== null) {
// 		// match[1] contains the content inside the quotes
// 		matches.push(match[1]);
// 	}

// 	return matches[0];
// };

// export const extractFilter = (
// 	text: string,
// ): { key: string; value: string } | null => {
// 	// Look for patterns like: post_type.contains("painting")
// 	const pattern = /(\w+)\.contains\("([^"]*)"\)/;
// 	const match = text.match(pattern);

// 	if (match) {
// 		return {
// 			key: match[1], // 'post_type'
// 			value: match[2], // 'painting'
// 		};
// 	}

// 	return null;
// };

// const extractQuery = (view: any) => {
// 	console.log(view);
// 	const queries = [];
// 	let folders: string[] = [];
// 	let filters: any[] = [];
// 	for (let v of view.filters.and) {
// 		if (v.contains("file.folder")) {
// 			folders.push(extractQuotedStrings(v));
// 		} else if (v.contains("contains")) {
// 			filters.push(extractFilter(v));
// 		}
// 	}

// 	return { folders, filters };
// };

// const extractColumns = (view: any) => {
// 	return view.order;
// };

// const getFilesFromFolder = async (
// 	main: IMainController,
// 	folder: string,
// 	filter?: { key: string; value: string },
// 	publicationAddress?: string,
// ) => {
// 	const files = await main.plugin.app.vault.getFiles();
// 	let filteredFiles = files.filter(
// 		(file) => file.path.startsWith(folder) && file.extension == "md",
// 	);

// 	// If we have a filter like post_type, apply it
// 	if (filter && filter.key && filter.value) {
// 		filteredFiles = filteredFiles.filter((file) => {
// 			const cache = main.plugin.app.metadataCache.getFileCache(file);
// 			const frontmatter = cache?.frontmatter;
// 			if (frontmatter) {
// 				const fieldValue = frontmatter[filter.key];

// 				// Check if field exists
// 				if (fieldValue !== undefined) {
// 					// If field is a string, check if it contains or equals the value
// 					if (typeof fieldValue === "string") {
// 						return (
// 							fieldValue.includes(filter.value) ||
// 							fieldValue === filter.value
// 						);
// 					}
// 					// If field is an array, check if it includes the value
// 					else if (Array.isArray(fieldValue)) {
// 						return fieldValue.some(
// 							(item) =>
// 								item === filter.value ||
// 								(typeof item === "string" &&
// 									item.includes(filter.value)),
// 						);
// 					}
// 					// Direct equality check as fallback
// 					else {
// 						return fieldValue === filter.value;
// 					}
// 				}
// 			}
// 			return false;
// 		});
// 	}

// 	// If publication address is provided, filter by hasDeal status
// 	if (publicationAddress) {
// 		const filesWithDeal: TFile[] = [];
		
// 		for (const file of filteredFiles) {
// 			const cache = main.plugin.app.metadataCache.getFileCache(file);
// 			const frontmatter = cache?.frontmatter;
			
// 			if (frontmatter && frontmatter.stream_id && typeof frontmatter.stream_id === "string" && frontmatter.stream_id.length > 0) {
// 				try {
// 					const hasDeal = await main.publication.hasDeal(
// 						publicationAddress,
// 						frontmatter.stream_id
// 					);
					
// 					if (hasDeal) {
// 						filesWithDeal.push(file);
// 					}
// 				} catch (err) {
// 					console.warn(`Error checking deal for ${frontmatter.stream_id}:`, err);
// 				}
// 			}
// 		}
		
// 		return filesWithDeal;
// 	}

// 	return filteredFiles;
// };

// const getFilesByFilter = async (
// 	main: IMainController,
// 	filters: { key: string; value: string }[],
// 	publicationAddress: string,
// ) => {
// 	const files = main.plugin.app.vault.getFiles();
// 	let filteredFiles: TFile[] = [];

// 	if (filters && filters.length > 0) {
// 		// Using for...of instead of filter with async callback
// 		const fileMatchMap: Map<TFile, any> = new Map();
// 		for (const file of files) {
// 			const cache = main.plugin.app.metadataCache.getFileCache(file);
// 			const frontmatter = cache?.frontmatter;
// 			if (!frontmatter || !frontmatter.stream_id) continue;

// 			let matchesAllFilters = true;
			
// 			for (const filter of filters) {
		
// 				const fieldValue = frontmatter[filter.key];


// 				// Skip if field doesn't exist
// 				if (fieldValue === undefined) {
// 					matchesAllFilters = false;
// 					break;
// 				}

// 				// Check if field contains or equals the filter value
// 				if (typeof fieldValue === "string") {

// 					if (
// 						!fieldValue.includes(filter.value) &&
// 						fieldValue !== filter.value
// 					) {
// 						matchesAllFilters = false;
// 						break;
// 					}
// 				}
// 				// If field is an array, check if it includes the value
// 				else if (Array.isArray(fieldValue)) {
// 					if (
// 						!fieldValue.some(
// 							(item) =>
// 								item === filter.value ||
// 								(typeof item === "string" &&
// 									item.includes(filter.value)),
// 						)
// 					) {
// 						matchesAllFilters = false;
// 						break;
// 					}
// 				}
// 				// Direct equality check as fallback
// 				else if (fieldValue !== filter.value) {
// 					matchesAllFilters = false;
// 					break;
// 				}
// 			}

// 			if (matchesAllFilters) {
// 				fileMatchMap.set(file, frontmatter);
// 				filteredFiles.push(file)
// 			}
// 		}

// 		// no need to check deals .. for now these are aggregates made from local machine ... 
// 		// issue is the nr of contract calls you can make inside the lit action. You cant replicate this there. 

// 		// if (fileMatchMap.size > 0) {
// 		// 	try {
// 		// 		// Process in batches of 24 to avoid contract errors
// 		// 		const BATCH_SIZE = 24;
// 		// 		const filesByStreamId: Map<string, TFile> = new Map();
				
// 		// 		// Filter out any non-string stream IDs and ensure they are valid strings
// 		// 		const streamIds: string[] = [];
				
// 		// 		// Create mapping from stream_id to file
// 		// 		for (const [file, frontmatter] of fileMatchMap.entries()) {
// 		// 			if (frontmatter.stream_id && typeof frontmatter.stream_id === "string" && frontmatter.stream_id.length > 0) {
// 		// 				streamIds.push(frontmatter.stream_id);
// 		// 				filesByStreamId.set(frontmatter.stream_id, file);
// 		// 			}
// 		// 		}
				
// 		// 		// Process streamIds in batches
// 		// 		const haveDeals: Record<string, boolean> = {};
				
// 		// 		// Use individual calls to avoid encoding issues
// 		// 		for (const streamId of streamIds) {
// 		// 			try {
// 		// 				const hasDeal = await main.publication.hasDeal(
// 		// 					publicationAddress,
// 		// 					streamId
// 		// 				);
// 		// 				haveDeals[streamId] = hasDeal;
// 		// 			} catch (err) {
// 		// 				console.warn(`Error checking deal for ${streamId}:`, err);
// 		// 				haveDeals[streamId] = false;
// 		// 			}
// 		// 		}
				
// 		// 		// Filter files based on deal status
// 		// 		for (const streamId in haveDeals) {
// 		// 			if (haveDeals[streamId] && filesByStreamId.has(streamId)) {
// 		// 				filteredFiles.push(filesByStreamId.get(streamId)!);
// 		// 			}
// 		// 		}
// 		// 	} catch (error) {
// 		// 		console.error("Error checking deals:", error);
// 		// 	}
// 		// }
// 	}

// 	return filteredFiles;
// };

// const extractData = async (
// 	main: IMainController,
// 	files: TFile[],
// 	columns: string[],
// ) => {
// 	const content: any[] = [];
// 	let streamId = null;

// 	for (let file of files) {
// 		const d: any = {};
// 		d.title = file.name.replace(/\.md$/, "");
// 		const cache = main.plugin.app.metadataCache.getFileCache(file);
// 		const frontmatter = cache?.frontmatter;
// 		if (frontmatter) {
// 			for (const column of columns.filter(
// 				(column) => frontmatter[column],
// 			)) {
// 				d[column] = frontmatter[column];
// 			}
// 			d.slug = d.title ? slugify(d.title).toLowerCase() : d.stream_id;
// 			d.post_type = frontmatter["post_type"];
// 		}
// 		const rawFile = await main.plugin.app.vault.read(file);
// 		console.log(file)
// 		let rawContent = rawFile.split("---")[2].trim();
// 		rawContent = rawContent.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
// 		rawContent = rawContent.replace(/^\n+/, "");
// 		d.content = marked(rawContent);
// 		content.push(d);
// 	}

// 	content.sort((a, b) => {
// 		// Sort by creation_date in descending order (newest first)
// 		const dateA = a.creation_date || 0;
// 		const dateB = b.creation_date || 0;
// 		return dateB - dateA; // Descending order
// 	});

// 	return content;
// };

// export const parseBase = async (
// 	main: IMainController,
// 	file: TFile,
// 	publicationAddress: string,
// ): Promise<any> => {
// 	let base: any = {};
// 	const rawFile = await main.plugin.app.vault.read(file);
// 	// egt pub address

// 	const views = _parseYaml(rawFile);
// 	const { folders, filters } = extractQuery(views[0]);
// 	let columns = extractColumns(views[0]);

// 	console.log(folders,filters, columns);

// 	if (folders && folders[0]) {
// 		const files = await getFilesFromFolder(
// 			main,
// 			folders[0],
// 			filters[0] || undefined,
// 			publicationAddress,
// 		);
// 		base[folders[0]] = await extractData(main, files, columns);
// 	} else if (filters && filters.length > 0) {
// 		const files = await getFilesByFilter(main, filters, publicationAddress);

// 		base[folders[0] || "serie"] = await extractData(main, files, columns);
// 	}

// 	console.log(base);

// 	return base;
// };
