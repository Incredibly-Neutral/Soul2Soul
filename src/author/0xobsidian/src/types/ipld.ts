export interface IpldNote {

    body: string,
    path: string,
    slug: string,
    title: string,
    [key:string] : any
}

export interface IpldLink {

    [key:string] : string
}

export interface IpldPod {

    Links: IpldLink[]
}