export interface SGContentItem {

    args: string,
	author: string,
    categories: string[],
    content: string,
    creation_date: string,
	modified_date: string,
	parent: string,
	post_type: string,
    publication:  string,
    sgId : string,
    tags: string[],
	thumbnail: string,
	title: string,

}

export interface SGTask {

	
	author: string,
	payload: any,
	post_type: string,
	publication: string,
    slug: string
}