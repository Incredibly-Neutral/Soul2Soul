import path from "path";
import { IMainController } from "../main.ctrlr";
import {
	// getFilesFromGithub,
	fetchFileFromGithub,
	getLatestCommitSHA,
	getAllFilesRecursive,
} from "./github";


import { S2SProtocolInfo, S2SPublication, S2SPublicationConfig } from "@s2s/soul2soul-shared";

// export const fetchOnChainPublicationConfig = async (
// 	main: IMainController,
// 	publicationAddress: string,
// ) => {
// 	const cid = await main.oxo.ctrlr.evm["BASE_SEPOLIA"].genericRead(
// 		publicationAddress,
// 		ABI_PUBLICATION,
// 		"getConfig",
// 		[],
// 	);
// 	return await main.oxo.ctrlr.ipfs.getJsonLike(
// 		cid,
// 		main.protocolInfo.dataGateway,
// 	);
// };

// export const updateContractWithConfig = async (
// 	main: IMainController,
// 	chainName: string,
// 	pub_contract: string,
// 	config_cid: string,
// ) => {
// 	const args = [config_cid];
// 	return await main.oxo.ctrlr.evm[chainName].genericTx(
// 		pub_contract,
// 		JSON.stringify(ABI_PUBLICATION),
// 		"updateConfig",
// 		args,
// 		false,
// 	);
// };

export const uploadConfig = async (
	main: IMainController,
	publication: S2SPublication,
): Promise<string | undefined> => {
	let config: any;
	let config_cid: string | undefined = undefined;

	if (publication.configCid != undefined) {
		config = await main.oxo.ctrlr.ipfs.getJsonLike(
			publication.configCid,
			main.protocolInfo.dataGateway,
		);
		if (config.Type == "error") {
			config = {};
		}
	} else {
		config = {};
	}

	if (config.stylesheets === undefined) {
		config.stylesheets = [];
	}
	if (config.templates === undefined) {
		config.templates = [];
	}

	try {


		const arr = publication.devRepository!.split("/");
		const profile = arr[arr.length - 2];
		const repo = arr[arr.length - 1];

		// const assets_files: any[] = await getAllFilesRecursive(
		// 	profile,
		// 	repo,
		// 	publication.branch || "",
		// 	"assets",
		// );
		// const assets_cids = JSON.parse(
		// 	JSON.stringify(config.assets.map((a: any) => a.cid)),
		// );

		// for (let asset of assets_files) {
		// 	// console.log("asset", asset);
		// 	const assetCid = await main.oxo.ctrlr.pinata.uploadFileFromUrl(
		// 		asset.url,
		// 		true,
		// 	);
		// 	// console.log("precalculated asset cid", assetCid, path.basename(asset.url));
		// 	if (!assets_cids.includes(assetCid)) {
		// 		//          console.log("new asset", assets_cids, assets_cids.includes(assetCid));
		// 		await main.oxo.ctrlr.pinata.uploadFileFromUrl(asset.url, false);

		// 		const existingAssetIndex = config.assets.findIndex(
		// 			(a: any) => a.path === asset.path,
		// 		);

		// 		if (existingAssetIndex !== -1) {
		// 			// Replace CID for existing asset with same path
		// 			config.assets[existingAssetIndex].cid = assetCid;
		// 			// console.log(
		// 			// 	`updated image CID for ${asset.path}: ${assetCid}`,
		// 			// );
		// 		} else {
		// 			// Upload new asset and add to config
		// 			config.assets.push({ path: asset.path, cid: assetCid });
		// 			// console.log(`new image uploaded to pinata: ${assetCid}`);
		// 		}
		// 	}
		// }

		// console.log("config assets", config.assets);

		// let stylesheet_files: any[] = await getAllFilesRecursive(
		// 	profile,
		// 	repo,
		// 	publication.branch || "",
		// 	"css",
		// );

		// stylesheet_files = stylesheet_files.filter((file: any) => {
		// 	return path.extname(file.path) === ".css";
		// });

		// console.log("stylesheet_files", stylesheet_files);

		// for (let stylesheet of stylesheet_files) {
		// 	const cid = await main.oxo.ctrlr.pinata.uploadFileFromUrl(
		// 		stylesheet.url,
		// 		true,
		// 	);

		// 	// console.log("precalculated cid", cid);

		// 	if (!config.stylesheets.map((a: any) => a.cid).includes(cid)) {
		// 		// console.log("new stylesheet");
		// 		await main.oxo.ctrlr.pinata.uploadFileFromUrl(
		// 			stylesheet.url,
		// 			false,
		// 		);

		// 		const existingAssetIndex = config.stylesheets.findIndex(
		// 			(a: any) => a.path === stylesheet.path,
		// 		);

		// 		if (existingAssetIndex !== -1) {
		// 			// Replace CID for existing asset with same path
		// 			config.stylesheets[existingAssetIndex].cid = cid;
		// 			// console.log(
		// 			// 	`updated stylesheet CID for ${stylesheet.path}: ${cid}`,
		// 			// );
		// 		} else {
		// 			// needs to be push or replace !!!!
		// 			config.stylesheets.push({
		// 				path: stylesheet.path,
		// 				cid: cid,
		// 			});
		// 			// console.log(`new stylesheet uploaded to pinata: ${cid}`);
		// 		}
		// 	}
		// }

		// console.log("config stylesheets", config.stylesheets);

		const template_files: any[] = await getAllFilesRecursive(
			profile,
			repo,
			publication.branch || "",
			"templates",
		);

		for (let template of template_files) {
			let templateContent = await fetchFileFromGithub(template.url);
			templateContent = templateContent.replace(/\n/g, "");
			templateContent = templateContent.replace(/\\([^\\])/g, "$1"); // Remove single backslashes except double backslashes
			
			const cid = await main.oxo.ctrlr.ipfs.add(
				templateContent,
				main.protocolInfo.dataGateway,
				true,
			);

			if (!config.templates.map((a: any) => a.cid).includes(cid)) {
				await main.oxo.ctrlr.ipfs.add(
					templateContent,
					main.protocolInfo.dataGateway,
					false,
				);
				const existingAssetIndex = config.templates.findIndex(
					(a: any) => a.path === template.path,
				);

				if (existingAssetIndex !== -1) {
					config.templates[existingAssetIndex].cid = cid;
					//  console.log(`updated template CID for ${template.path}: ${cid}`);
				} else {
					config.templates.push({
						path: template.path,
						cid: cid,
						body: templateContent,
					});
					// console.log(` new template uploaded to ipfs: ${cid}`);
				}
			} else {
				//   console.log("template already exists in config, skipping upload");
			}
		}

		let templatesCid = await main.oxo.ctrlr.ipfs.dagPut(
			config.templates,
			main.protocolInfo.dataGateway,
		);

		const commit_sha = await getLatestCommitSHA(publication);

		const mapping = await fetchFileFromGithub(
			`https://raw.githubusercontent.com/${profile}/${repo}/${commit_sha}/mapping.json`,
		);
		//  console.log("mapping", mapping);
		//
		// const renderActionCid = await main.oxo.ctrlr.pinata.uploadFileFromUrl(
		// 	`https://raw.githubusercontent.com/${profile}/${repo}/${commit_sha}/renderer/dist/main.js`,
		// 	false,
		// 	0,
		// );
		// console.log("renderActionCid", renderActionCid);

		const publication_config = createConfig(
			main.protocolInfo,
			publication,
			config,
			templatesCid,
			mapping,
			// renderActionCid,
		);
		//  console.log("config", publication_config);
		config_cid = await main.oxo.ctrlr.ipfs.add(
			publication_config,
			main.protocolInfo.dataGateway,
		);
	} catch (error) {
		console.log(error);
	}
	return config_cid;
};

export const createConfig = (
	protocolInfo: S2SProtocolInfo,
	publication: S2SPublication,
	config: any,
	templatesCid: string,
	mapping: string,
): S2SPublicationConfig => {

	return {
		assetsCid: "",
		contract: publication.contract || "",
		dataGateway: protocolInfo.dataGateway || "",
		mapping: JSON.parse(mapping),
		name: publication.name,
		templateCid: templatesCid,
	};
};
