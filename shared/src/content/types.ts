export interface S2SPublicContent {

    creationDate:  number,
	modifiedDate: number,
	language: string,
    parent: number,
    position: number,
	postType: string,
    publications: string[],
    tags: string[],
    plainTextHash: string
}

export interface S2SToEncrypt {

    content: string,
    custom: string,
    title: string,
    slug: string
}

export interface S2SContentItem extends S2SPublicContent {
    encrypted: string
}