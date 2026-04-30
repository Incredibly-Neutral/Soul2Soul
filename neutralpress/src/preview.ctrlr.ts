import { TFile, MarkdownView, WorkspaceLeaf, ItemView, ViewCreator, requestUrl } from 'obsidian';
import { MainController } from './main.ctrlr';

const HTML_VIEW_TYPE = 'neutralpress-html-preview';

class HTMLView extends ItemView {
    content: string = '';

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return HTML_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'HTML Preview';
    }

    setHTML(html: string) {
        this.content = html;
        this.contentEl.empty();
        
        this.contentEl.innerHTML = html;
    }

    async onOpen() {
        this.contentEl.empty();
        this.contentEl.innerHTML = this.content;
    }
}

export class PreviewCtrlr {

    main: MainController;

    constructor(main: MainController) {
        this.main = main;
        // Register the custom view
        this.main.plugin.registerView(
            HTML_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new HTMLView(leaf)
        );
    }

    public async display(html: string): Promise<void> {

        console.log(html);


        
        // Get or create HTML preview leaf
        let leaf = this.main.plugin.app.workspace.getLeavesOfType(HTML_VIEW_TYPE)[0];
        if (!leaf) {
            leaf = this.main.plugin.app.workspace.getLeaf('split');
            await leaf.setViewState({
                type: HTML_VIEW_TYPE
            });
        }

        // Set the HTML content
        if (leaf.view instanceof HTMLView) {
            leaf.view.setHTML(html);
            
            // Create a temporary DOM parser to find the stylesheet
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const styleLinks = [].slice.call(doc.querySelectorAll('link[rel="stylesheet"]'));
            for (const styleLink of styleLinks) {
                if (styleLink && styleLink.getAttribute('href')) {
                    // console.log(styleLink.getAttribute('href'));
                   await this.injectStylesheet(styleLink.getAttribute('href')!);
                }
            }
        }
    }

    public async renderHTML (stream_id: string, publication: string): Promise<string> {
        try {
            const response = await requestUrl({
                url: 'http://localhost:3004/preview',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    stream_id,
                    publication
                })
            });
            
            return response.text;
        } catch (error) {
            console.error('HTTP request error:', error);
            throw error;
        }
    }

    async injectStylesheet(url: string) {

        if (url.includes("https://cloud.typography.com")) {
            return;
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.error("Failed to fetch stylesheet:", response.statusText);
                return;
            }
            const css = await response.text();

            // console.log(css);
            
            // Inject CSS into a <style> tag
            const styleTag = document.createElement("style");
            styleTag.textContent = css;
            document.head.appendChild(styleTag);
        } catch (error) {
            console.error("Error loading stylesheet:", error);
        }
    }
}