import { App, TFile } from "obsidian";
import { IMainController } from "../main.ctrlr";
import slugify from "slugify";
import { marked } from "marked";
import { distributeImages } from "./images";
import * as crypto from "crypto";
import { getAddress } from "viem";
import {
  buildSignedContentItem,
  type S2SContentItem,
  noOpEncrypt,
  toDidEthr,
} from "@s2s/soul2soul-shared";

export interface IContentController {
    main: IMainController
    /** Build and sign a content item from an Obsidian note, then update frontmatter */
    publishContent: (file: TFile, subdomain: string) => Promise<S2SContentItem | null>;
}

export class ContentController implements IContentController {
    main: IMainController;

    constructor (main: IMainController) {
        this.main = main
    }

    /**
     * Parse an Obsidian note and produce the raw pieces needed for signing.
     * Returns structured data without any Lens-era type baggage.
     */
    parseNote = async (file: TFile): Promise<{
        contentId: string | null;
        postType: string;
        locale: string;
        tags: string[];
        parent: number;
        position: number;
        encryption: boolean;
        title: string;
        slug: string;
        content: string;
        custom: Record<string, unknown>;
    }> => {
        const rawFile = await this.main.plugin.app.vault.read(file);

        const frontmatter = await this.parseContentFrontmatter(file, this.main.plugin.app);
        const title = file.name.replace(/\.[^/.]+$/, "") || frontmatter.title || "";

        let [body, extractedTitle, _baseFileName] = this.extractTitleAndBase(rawFile, title);
        const resolvedTitle = extractedTitle || title;
        const slug = this.slug(resolvedTitle);

        const tags = frontmatter.tags ? JSON.parse(JSON.stringify(frontmatter.tags)) : [];
        const publications = tags
            .filter((tag: string) => tag.endsWith("--s2s"))
            .map((tag: string) => tag.replace("--s2s", ".soul2soul.eth"));

        let mdContent = await marked(body);
        mdContent = await distributeImages(
            this.main,
            this.main.plugin.app,
            file,
            mdContent,
            this.main.protocolInfo.gateway,
        );

        return {
            contentId: frontmatter.content_id || null,
            postType: frontmatter.post_type || "post",
            locale: frontmatter.language || "en",
            tags,
            parent: frontmatter.parent ? parseInt(frontmatter.parent) : 0,
            position: frontmatter.position ? parseInt(frontmatter.position) : 0,
            encryption: frontmatter.encryption || false,
            title: resolvedTitle,
            slug,
            content: mdContent,
            custom: frontmatter.custom || {},
        };
    };

    /**
     * Build a signed S2SContentItem from an Obsidian note and publish it.
     * Replaces the old Lens-based storeNoteOnLens.
     *
     * Signing happens via the 0xobsidian BASE account's EOA (asTypedDataSigner).
     * The signed object is stored in frontmatter for later use by the render pipeline.
     */
    async publishContent(file: TFile, subdomain: string): Promise<S2SContentItem | null> {
        const parsed = await this.parseNote(file);
        const baseAccount = this.main.oxo.ctrlr.account["BASE"];

        if (!baseAccount?.signTypedData) {
            console.warn("No BASE account available for signing; content not signed");
            return null;
        }

        const signer = baseAccount.asTypedDataSigner();
        const now = Math.floor(Date.now() / 1000);

        // Read existing genesis from frontmatter (stable identity for updates)
        const cache = this.main.plugin.app.metadataCache.getFileCache(file);
        const existingGenesis: string | null = cache?.frontmatter?.genesis || null;
        console.log("existing genesis", existingGenesis)

        try {
            const signedItem = await buildSignedContentItem(
                {

                    specVersion: "1",
                    postType: parsed.postType,
                    mediaType: "text/markdown",
                    parent: String(parsed.parent),
                    position: String(parsed.position),
                    publication: subdomain,
                    locale: parsed.locale,
                    createdAt: now,
                    tags: parsed.tags,
                    attributes: undefined,
                },
                {
                    title: parsed.title,
                    slug: parsed.slug,
                    content: parsed.content,
                    custom: parsed.custom,
                },
                signer,
                noOpEncrypt,
                // Author is the Safe address (on-chain msg.sender).
                // The EOA that signs is a Safe owner, verified off-chain.
                toDidEthr(baseAccount.address),
            );

            console.log("publishing:", signedItem);

            // Preserve the original genesis on updates — the contract
            // identifies content by its first-publish (genesis) objectId.
            // Only the very first publish creates a new identity.
            const objectId = existingGenesis ?? signedItem.objectId;
            console.log("oid", objectId)

            // Store signed metadata to frontmatter (genesis publish only)
            if (!existingGenesis) {
                // Format modified time to match creation_date (no ms, no Z)
                const mtime = new Date(file.stat.mtime).toJSON().split(".")[0];
                await this.updateFrontMatter(this.main.plugin.app, file, "genesis", objectId);
                await this.updateFrontMatter(this.main.plugin.app, file, "author", signedItem.public.author);
                await this.updateFrontMatter(this.main.plugin.app, file, "modified_date", mtime);
            }

            return { ...signedItem, objectId };

        } catch (err) {
            console.error("publishContent: signing failed:", err);
            return null;
        }
    }

    /** Parse frontmatter from Obsidian metadata cache — returns raw fields */
    parseContentFrontmatter = async (file: TFile, app: App): Promise<Record<string, any>> => {
        return new Promise((resolve, reject) => {
            const cache = app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter || {};

            // Update modified date
            const now = new Date().toJSON().split(".")[0];
            frontmatter.modified_date = now;
            this.updateFrontMatter(app, file, "modified_date", now);

            if (frontmatter.creation_date == undefined) {
                frontmatter.creation_date = now;
                this.updateFrontMatter(app, file, "creation_date", now);
            }

            resolve(frontmatter);
        });
    };

    extractTitleAndBase(raw: string, fallbackTitle: string): [string, string | undefined, string | undefined] {
        let baseFileName: string | undefined;
        let content = raw.split("---")[2]?.trim() || "";

        // Check if content contains any .base references
        const baseRegex = /!\[\[(.*?)\.base(\.md)?\]\]/g;
        const baseMatches = content.match(baseRegex);
        if (baseMatches) {
            baseFileName = baseMatches[0].replace(/!\[\[(.*?)\]\]/g, "$1");
            content = content.replace(baseRegex, "");
        }

        content = content.replace(/^\n+/, "");

        let title: string | undefined = fallbackTitle;
        if (content.slice(0, 2) === "# ") {
            const parts = content.split("\n");
            title = parts[0].replace("# ", "").trim();
            parts.shift();
            content = parts.join("\n").trim();
        }

        return [content, title, baseFileName];
    }

    slug(title: string): string {
        const options = {
            lower: true,
            remove: /['"?!.,:;()\[\]{}@#$%^&*+=<>~`|\\]/g,
            strict: true,
        };
        return slugify(title, options);
    }

    updateFrontMatter = async (app: App, file: TFile, key: string, value: string | string[]) => {
        if (file != null) {
            await app.fileManager.processFrontMatter(file, (frontmatter) => {
                frontmatter[key] = value;
            });
        }
    };

    getFrontMatter = async (app: App, file: TFile): Promise<any> => {
        return new Promise(async (resolve, reject) => {
            await app.fileManager.processFrontMatter(file, (frontmatter) => {
                resolve(frontmatter);
            });
        });
    };
}