import { App, TFile } from "obsidian";
import { IMainController } from "../main.ctrlr";
import { postToLens, S2SPublicContent, S2SToEncrypt, updateToLens, S2SContentItem, canRead } from "@s2s/soul2soul-shared";
import slugify from "slugify";
import { marked } from "marked";
import { distributeImages } from "./images";
import * as crypto from "crypto";
import * as ethers from 'ethers' 

export interface IContentController {

    main: IMainController
    storeNoteOnLens : (file: TFile, contentId: string, publicContent: S2SPublicContent, toEncrypt: S2SToEncrypt, subdomain: string) => Promise<void>
}

export class ContentController implements IContentController {
    main: IMainController;

    constructor (main: IMainController) {
        this.main = main
    }

    async encryptContent ( oxoCtrlr: any,  contentId: string, publicationModule: string, toEncrypt: any ): Promise<string>  {

        const unifiedControlConditions = canRead(
            contentId,
            ethers.getAddress(oxoCtrlr.user.safe),
            ethers.getAddress(publicationModule),
        );

        return JSON.stringify(
            await oxoCtrlr.lit.encryptWithUcc(
                JSON.stringify(toEncrypt),
                unifiedControlConditions,
            ),
        );
    };

    async storeNoteOnLens(file: TFile, contentId: string, publicContent: S2SPublicContent, toEncrypt: S2SToEncrypt, subdomain: string) {

        const service = await this.main.getInitializedService(subdomain);
        const feed = await service.getPublicationFeedAddress();
        const pubAddress = await service.getMultiSig();

        console.log("PUBLICATION", pubAddress)
        
        try {
             
            const publicationModule = service.publicationModule;
        
            if (contentId == null) {
                console.log(
                    "No stream ID found, mocking the insert to get a contentId",
                );
                const mockedItem = {
                    ...publicContent,
                    encrypted: "{}",
                };

                const postId = await postToLens(
                    this.main.oxo.ctrlr.user,
                    this.main.oxo.ctrlr.lens,
                    mockedItem,
                    feed
                );
                
                contentId = postId;

                await this.updateFrontMatter(
                    this.main.plugin.app,
                    file,
                    "content_id",
                    contentId,
                );
            }

            if (publicContent != null) {
                
                const encrypted = await this.encryptContent(
                    this.main.oxo.ctrlr,
                    contentId,
                    publicationModule,
                    toEncrypt,
                );

                const contentItem: S2SContentItem = {
                    ...publicContent,
                    encrypted: encrypted,
                };

                if (contentId) {
                    // console.log("updating");
                    const res = await updateToLens(
                        this.main.oxo.ctrlr.user,
                        this.main.oxo.ctrlr.lens,
                        contentItem,
                        contentId
                    );
                        
                    // console.log(res);
                } else {

                    // console.log("inserting");
                    const res = await postToLens(
                        this.main.oxo.ctrlr.lens,
                        this.main.oxo.ctrlr.user,
                        contentItem,
                        feed
                    );
                    // console.log(res);
                }
            }
            
        } catch (error) {
            console.error("Error in storeNote:", error);
            console.error("Error details:", {
                message: error.message,
                stack: error.stack,
                oxoState: this.main.oxo?.ctrlr ? "Initialized" : "Not initialized",
            });
            throw error;
        }
    }

    updateFrontMatter = async(app:App, file: TFile, key: string, value: string | string[]) => {

        if (file != null) {
            await app.fileManager.processFrontMatter( file, (frontmatter) => {
                frontmatter[key] = value;
            })
        }
    }

    getFrontMatter = async (app: App, file: TFile) : Promise<any> => {

        return new Promise( async (resolve,reject) => {
            await app.fileManager.processFrontMatter( file, (frontmatter) => {
                resolve(frontmatter);
            })
        })
    }

    parseNote = async ( file: TFile): Promise<{ contentId: string; publicContent: S2SPublicContent; toEncrypt: S2SToEncrypt }> => {

        const rawFile = await this.main.plugin.app.vault.read(file);

        let { contentId, publicContent, toEncrypt } = await this.parseContentFrontmatter(file, this.main.plugin.app);

        if (file.name != undefined) toEncrypt.title = file.name.replace(/\.[^/.]+$/, "");
        let [content, title, baseFileName] = this.extractTitleAndBase(rawFile, toEncrypt.title);
        toEncrypt.slug = this.slug(title || toEncrypt.title);
        publicContent.plainTextHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");

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
            this.main,
            this.main.plugin.app,
            file,
            toEncrypt.content,
            this.main.protocolInfo.assetsGateway,
        );

        if (title != undefined && title != "") toEncrypt.title = title;

        return { contentId, publicContent, toEncrypt };
    };

    extractTitleAndBase ( raw: string, title: string ): [string, string | undefined, string | undefined] {
        
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

    parseContentFrontmatter = async ( file: TFile, app: App ): Promise<{ contentId: string; publicContent: S2SPublicContent; toEncrypt: S2SToEncrypt }> => {
        
        return new Promise(async (resolve: any, reject: any) => {
            const cache = app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter;

            if (frontmatter != null) {
                const contentId =
                    frontmatter.stream_id != undefined
                        ? frontmatter.stream_id
                        : null;

                // possibly check if content was modified ???
                const now = new Date().toJSON().split(".")[0];
                frontmatter.modified_date = now;
                this.updateFrontMatter(app, file, "modified_date", now)


                if (frontmatter.creation_date == undefined) {
                    frontmatter.creation_date = now;
                    this.updateFrontMatter(app, file, "creation_date", now)
                }

                if (frontmatter.position == undefined) {
                    frontmatter.position = "0";
                    this.updateFrontMatter(app, file, "position", frontmatter.position)
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

                const publicContent: S2SPublicContent = {
                    creationDate: Math.floor(
                        new Date(frontmatter.creation_date).getTime() / 1000,
                    ),
                    modifiedDate: Math.floor(
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
                    postType: frontmatter.post_type,
                    publications,
                    tags,
                    plainTextHash: ""
                };

                const toEncrypt: S2SToEncrypt = {
                    content: "",
                    title: "",
                    custom: JSON.stringify(
                        this.skipDefault(JSON.parse(JSON.stringify(frontmatter))),
                    ),
                    slug: "",
                };

                resolve({ contentId, publicContent, toEncrypt });
            }
        });
    };

    slug(title: string): string {
        
        const options = {
            lower: true, // Convert to lowercase
            remove: /['"?!.,:;()\[\]{}@#$%^&*+=<>~`|\\]/g, // Remove special characters that are unsafe for URLs
            strict: true, // Replace spaces with dashes
        };

	    return slugify(title, options);
    }

    removeCodeBlocks(text: string) {
        return text.replace(/```[\s\S]*?```/g, "");
    };

    removeMarkdownImages(text: string) {
        return text.replace(/!\[.*?\]\(.*?\)/g, "");
    };

    skipDefault(fmcopy: Record<string, any>): Record<string, any> {

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

}